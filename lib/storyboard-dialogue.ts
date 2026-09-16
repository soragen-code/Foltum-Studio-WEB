/** Stage 132 — original-language speech ledger. Storyboard only; no translation or network.
 * Parsing is deliberately fail-closed: unattributed quoted speech must not become silent animation.
 * Duration is a conservative planning ESTIMATE, not a speech synthesis measurement.
 */
export interface SpokenLine { speaker: string; text: string; delivery: string }
export interface SpeechSegment extends SpokenLine { id: string; sourceId: string; estimatedSec: number }
const QUOTES = /"([^"\n]+)"|«([^»]+)»|“([^”]+)”|(?<!\p{L})'([^'\n]+)'(?!\p{L})/gu;
const escapeRE = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function extractSpokenLines(source: string, cast: string[] = []): SpokenLine[] {
  const lines: SpokenLine[] = [];
  const positions: number[] = [];
  let lastEnd = 0;
  const quotes = [...source.matchAll(QUOTES)];
  for (const q of quotes) {
    const prefix = source.slice(lastEnd, q.index).split(/[\n.!?]/).pop()!.trim();
    // Prefer exact cast labels (including prose 'Anna whispers: "..."').
    const candidates = cast.flatMap(name => {
      const m = [...prefix.matchAll(new RegExp(`(?:^|[^\\p{L}])(${escapeRE(name)})(?=$|[^\\p{L}])`, "giu"))].pop();
      return m ? [{ name, end: m.index! + m[0].length }] : [];
    }).sort((a, b) => b.end - a.end);
    // In 'Anna asks Boris: "..."' Anna speaks, not the last name (Boris).
    const reporter = candidates.find(c => /^\s*(?:\([^)]*\)\s*)?(?:says?|asks?|whispers?|shouts?|answers?|replies|murmurs?|говорит|спрашивает|шепчет|отвечает|кричит)\b/iu.test(prefix.slice(c.end)));
    const selected = reporter ?? candidates.find(c => /^\s*(?:\([^)]*\))?\s*[:—-]?\s*$/u.test(prefix.slice(c.end)));
    // Prose may include physical action before 'speaking'; keep attribution only when there is one candidate.
    const candidate = selected ?? (candidates.length === 1 ? candidates[0] : undefined);
    let speaker = candidate?.name;
    let delivery = speaker ? prefix.slice(candidate!.end).replace(/^\s*[:—-]\s*|\s*[:—-]\s*$/g, "").trim() : "";
    if (!speaker) {
      const label = prefix.match(/^([\p{L}][\p{L}\p{N} .'-]*?)\s*(\([^)]*\))?\s*:\s*$/u);
      if (label && (!cast.length || cast.includes(label[1].trim()))) {
        speaker = label[1].trim(); delivery = label[2] ?? "";
      }
    }
    if (!speaker) throw new Error("Dialogue attribution conflict: quoted speech has no unambiguous cast speaker. Rebuild boards with explicit NAME (delivery): quoted line.");
    lines.push({ speaker, text: q[1] ?? q[2] ?? q[3] ?? q[4], delivery });
    positions.push(q.index!);
    lastEnd = q.index! + q[0].length;
  }
  // Also accept line-oriented NAME (cue): unquoted text, but never interpret action headings as speakers.
  let rowOffset = 0;
  for (const row of source.split("\n")) {
    const offset = rowOffset;
    rowOffset += row.length + 1;
    if (quotes.some(q => q.index! >= offset && q.index! < rowOffset)) continue;
    const m = row.trim().match(/^([\p{L}][\p{L}\p{N} .'-]*?)\s*(\([^)]*\))?\s*:\s*(\S.*)$/u);
    if (m && cast.includes(m[1].trim())) {
      lines.push({ speaker: m[1].trim(), delivery: m[2] ?? "", text: m[3] });
      positions.push(offset);
    }
  }
  return lines.map((line, i) => ({ line, position: positions[i] })).sort((a, b) => a.position - b.position).map(item => item.line);
}

export function estimatedSpeechSeconds(line: SpokenLine): number {
  const words = line.text.trim().split(/\s+/u).filter(Boolean).length;
  const slow = /slow|whisper|hesitan|pause|медлен|ш[её]пот|пауза/iu.test(line.delivery);
  return Math.max(words / (slow ? 1.6 : 2), [...line.text].length / (slow ? 10 : 13)) + 0.6;
}

/** Split ONLY at natural punctuation boundaries; preserve every character and the original order.
 * An overlong unbroken clause is an explicit conflict, never truncated or spoken faster.
 */
export function segmentSpeech(lines: SpokenLine[]): SpeechSegment[] {
  return lines.flatMap((line, index) => {
    const sourceId = `speech-${index + 1}`;
    const clauses = line.text.match(/[^.!?;,…—]+(?:[.!?;,…—]+\s*|$)/gu) ?? [line.text];
    if (clauses.join("") !== line.text) throw new Error("Dialogue segmentation conflict: punctuation cannot be split losslessly.");
    const chunks: string[] = [];
    let chunk = "";
    for (const clause of clauses) {
      if (estimatedSpeechSeconds({ ...line, text: clause }) > 6)
        throw new Error(`Dialogue duration conflict for ${line.speaker}: an uninterrupted phrase exceeds the 6s planning budget. Revise its phrasing or approve a different duration separately; no text was removed.`);
      if (chunk && estimatedSpeechSeconds({ ...line, text: chunk + clause }) > 6) { chunks.push(chunk); chunk = ""; }
      chunk += clause;
    }
    if (chunk) chunks.push(chunk);
    return chunks.map((text, part) => ({ ...line, text, sourceId, id: `${sourceId}.${part + 1}`, estimatedSec: estimatedSpeechSeconds({ ...line, text }) }));
  });
}

export interface StoryboardScriptScene { number: number; action: string | null; dialogue: string | null }
export function storyboardSource(episode: { script?: string | null; description?: string | null }, scenes: StoryboardScriptScene[], cast: string[]) {
  // Scene.dialogue is the original/story-language script; NEVER substitute dialogueEn or translate it.
  const ordered = [...scenes].sort((a, b) => a.number - b.number);
  const source = ordered.length
    ? ordered.map(s => `ACTION: ${s.action ?? ""}\n${s.dialogue ?? ""}`).join("\n\n")
    : (episode.script?.trim() || episode.description?.trim() || "");
  const speech = ordered.length
    ? ordered.flatMap(s => {
      const text = s.dialogue?.trim() ?? "";
      const found = extractSpokenLines(text, cast);
      if (text && !found.length && !/^\[?(?:NO DIALOGUE|SILENCE|NON-VERBAL|БЕЗ ДИАЛОГА)\]?$/iu.test(text))
        throw new Error(`Source dialogue format conflict in scene ${s.number}: preserve explicit speaker attribution before splitting.`);
      return found;
    })
    : extractSpokenLines(source, cast);
  const segments = segmentSpeech(speech);
  if (segments.reduce((sum, s) => sum + s.estimatedSec, 0) > 90)
    throw new Error("Dialogue duration conflict: original speech exceeds the 15 × 6s planning budget. No lines were omitted; approve a script/budget change separately.");
  return { source, segments, actionSource: ordered.length ? ordered.map(s => s.action ?? "").join("\n") : source };
}

/** Movement evidence must describe physical travel, never words inside dialogue or negated/future actions. */
export function hasActorTravel(evidence: string): boolean {
  const unspoken = evidence.replace(QUOTES, "").replace(/\b(?:camera|lens)\b[^.!?;\n]*/gi, "");
  return unspoken.split(/[.!?;\n]|\bbut\b|\bhowever\b|(?:^|\s)но(?:\s|$)/iu).some(clause => {
    const travel = /\b(?:walks?|walking|walked|sprints?|sprinting|runs?|running|strides?|striding|strolls?|strolling|crosses|crossing|steps? (?:toward|towards|across|away|into|out)|moves? (?:across|through|toward|towards|along|down|away|into|out)|moving (?:across|through|toward|towards|along|down|away|into|out))\b|(?:^|\s)(?:ид[её]т|идут|шагает|шагают|бежит|бегут|переходит|пересекает|направляется|направляются)(?=\s|$)/giu;
    return [...clause.matchAll(travel)].some(match => {
      const before = clause.slice(0, match.index).split(/\band\b|(?:^|\s)и(?:\s|$)/iu).pop()!;
      const after = clause.slice(match.index! + match[0].length);
      if (/\b(?:not|never|no|without|cannot|can't|won't|doesn't|don't|didn't|isn't|aren't|will|would|could|plans?|wants?|says?|mentions?|asks?|imagines?|talks?|thinking|stops?|stopped)\b|(?:^|\s)(?:не|нет|никогда|без|хочет|планирует|говорит)(?:\s|$)/iu.test(before)) return false;
      if (/^(?:-in|-ie)|^\s+(?:in place|on a treadmill|through the plan)\b/iu.test(after)) return false;
      return true;
    });
  });
}
