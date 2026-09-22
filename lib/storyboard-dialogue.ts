/** Stage 132 — speech ledger. Storyboard only; no translation or network in THIS module (pure parsing).
 * Stage 141: the worker translates every source line to ENGLISH before building the ledger, so the text
 * parsed and restored here is English; this module never translates and preserves the text verbatim.
 * Parsing is deliberately fail-closed: unattributed quoted speech must not become silent animation.
 * Duration is a conservative planning ESTIMATE, not a speech synthesis measurement.
 */
/** `addressee` is the cast member THIS line is spoken to (its eyeline / reverse-shot target). It is
 * OPTIONAL and used only for staging/eyeline — it never influences who the speaker is, so a wrong or
 * missing addressee can never silently reassign a line. Undefined = spoken to the group / unknown. */
/** Stage 152 — `scene` is the 1-based source scene number this line belongs to (set by the source builders
 * from the ordered script scenes). It lets planSceneCoverage detect scene boundaries so the FIRST board of
 * every scene opens on a close-up of that scene's first speaker. Optional (undefined for the no-scenes
 * fallback path and for older persisted data), so nothing else changes when scene identity is unknown. */
export interface SpokenLine { speaker: string; text: string; delivery: string; addressee?: string; scene?: number }
export interface SpeechSegment extends SpokenLine { id: string; sourceId: string; estimatedSec: number }
/** A cast member for attribution: canonical NAME plus optional gender-lock and aliases/diminutives.
 * Plain strings stay supported (name only). The canonical `name` is ALWAYS what is returned as the
 * speaker, even when the source used an alias. */
export interface CastMember { name: string; gender?: string | null; aliases?: string[] }
export type CastInput = string | CastMember;
const QUOTES = /"([^"\n]+)"|«([^»]+)»|“([^”]+)”|(?<!\p{L})'([^'\n]+)'(?!\p{L})/gu;
const escapeRE = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reporter verbs (EN + RU) used to detect "NAME says/asks/whispers ..." attribution in prose. */
const REPORTER_VERB = "says?|asks?|whispers?|shouts?|answers?|answered|replies|replied|murmurs?|adds?|added|continues?|continued|говорит|сказал[аи]?|спрашивает|спросил[аи]?|шепчет|шепнул[аи]?|отвечает|ответил[аи]?|кричит|крикнул[аи]?|добавляет|добавил[аи]?";
const REPORTER_TAIL = new RegExp(`^\\s*(?:\\([^)]*\\)\\s*)?(?:${REPORTER_VERB})\\b`, "iu");

interface CastNorm { name: string; gender: string | null; forms: string[] }
function normalizeCast(cast: CastInput[]): CastNorm[] {
  return cast.map(c => {
    const m: CastMember = typeof c === "string" ? { name: c } : c;
    const aliases = (m.aliases ?? []).map(a => (a ?? "").trim()).filter(Boolean);
    return { name: m.name, gender: (m.gender ?? null), forms: [m.name, ...aliases].filter(Boolean) };
  });
}

interface Mention { name: string; gender: string | null; start: number; end: number }
/** Every cast mention (by canonical name OR alias) inside `text`, deduped, in source order. */
function castMentions(text: string, cast: CastNorm[]): Mention[] {
  const found: Mention[] = [];
  for (const c of cast) for (const form of c.forms) {
    for (const m of text.matchAll(new RegExp(`(?:^|[^\\p{L}])(${escapeRE(form)})(?=$|[^\\p{L}])`, "giu"))) {
      const end = m.index! + m[0].length; // group 1 (the name) sits at the very end of the match
      found.push({ name: c.name, gender: c.gender, start: end - m[1].length, end });
    }
  }
  // Dedup overlapping mentions at the same position (name vs. alias), keeping the longest form.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  return found.filter((m, i) => i === 0 || m.start >= found[i - 1].end);
}

/** Gender named by a pronoun reporter ("she whispers" / "он сказал"), when there is no cast mention. */
function genderHintOf(prefix: string): "male" | "female" | null {
  const m = prefix.match(new RegExp(`(?:^|[^\\p{L}])(she|he|она|он)\\s+(?:\\([^)]*\\)\\s*)?(?:${REPORTER_VERB})\\b`, "iu"));
  if (!m) return null;
  const p = m[1].toLowerCase();
  return p === "she" || p === "она" ? "female" : "male";
}

/** Strip a wrapping parenthesis, leading/trailing separators, and any cast name (e.g. the addressee
 * in "asks Boris") from a raw delivery cue, so the persisted form is a clean manner/intonation note. */
function cleanDelivery(raw: string, cast: CastNorm[]): string {
  let d = (raw ?? "").trim().replace(/^[:—-]\s*|\s*[:—-]$/g, "").trim();
  const paren = d.match(/^\((.*)\)$/su);
  if (paren) d = paren[1].trim();
  for (const c of cast) for (const form of c.forms)
    d = d.replace(new RegExp(`(?:^|[^\\p{L}])${escapeRE(form)}(?=$|[^\\p{L}])`, "giu"), " ");
  return d.replace(/\s+/g, " ").trim();
}

interface SpeechEvent { text: string; delivery: string; position: number; speaker?: string; addressee?: string; genderHint?: "male" | "female" | null }

/** Explicit attribution from the prose immediately before a quote. Returns an undefined speaker when
 * the prefix carries no unambiguous cast cue (resolved later by turn-taking / alternation / gender). */
function attributeFromPrefix(prefix: string, cast: CastNorm[]): { speaker?: string; addressee?: string; delivery: string; genderHint: "male" | "female" | null } {
  const mentions = castMentions(prefix, cast);
  const byEnd = [...mentions].sort((a, b) => b.end - a.end);
  // "Anna asks Boris: ..." → Anna speaks (verb owner), Boris is the addressee, not the speaker.
  const reporter = byEnd.find(m => REPORTER_TAIL.test(prefix.slice(m.end)));
  const labelled = byEnd.find(m => /^\s*(?:\([^)]*\))?\s*[:—-]?\s*$/u.test(prefix.slice(m.end)));
  const chosen = reporter ?? labelled ?? (mentions.length === 1 ? mentions[0] : undefined);
  if (!chosen) return { delivery: "", genderHint: genderHintOf(prefix) };
  const addressee = mentions.find(m => m.start >= chosen.end && m.name !== chosen.name)?.name;
  return { speaker: chosen.name, addressee, delivery: prefix.slice(chosen.end), genderHint: null };
}

/** Deterministic second pass: resolve every still-unattributed line without guessing randomly.
 * Priority: (1) gendered pronoun reporter matching a unique cast member, (2) reply to the partner the
 * previous line explicitly addressed (turn-taking), (3) strict two-hander alternation from the last
 * known speaker. Anything left unresolved stays undefined and is reported as a conflict — never guessed. */
function resolveSpeakers(events: SpeechEvent[], cast: CastNorm[]): void {
  const names = cast.map(c => c.name);
  let lastSpeaker: string | undefined;
  let pendingAddressee: string | undefined;
  for (const e of events) {
    if (!e.speaker) {
      if (e.genderHint) {
        const g = cast.filter(c => c.gender === e.genderHint);
        if (g.length === 1) e.speaker = g[0].name;
      }
      if (!e.speaker && pendingAddressee && pendingAddressee !== lastSpeaker && names.includes(pendingAddressee))
        e.speaker = pendingAddressee;
      if (!e.speaker && names.length === 2 && lastSpeaker)
        e.speaker = names.find(n => n !== lastSpeaker);
    }
    if (e.speaker) { lastSpeaker = e.speaker; pendingAddressee = e.addressee; }
  }
}

/** Parse the raw quote + line-oriented speech events out of a source block, in source order.
 * Attribution from the immediately-preceding prose is applied, but nothing is resolved or rejected yet. */
function buildSpeechEvents(source: string, castNorm: CastNorm[]): SpeechEvent[] {
  const events: SpeechEvent[] = [];
  const quotes = [...source.matchAll(QUOTES)];
  let lastEnd = 0;
  for (const q of quotes) {
    const prefix = source.slice(lastEnd, q.index).split(/[\n.!?]/).pop()!.trim();
    const att = attributeFromPrefix(prefix, castNorm);
    events.push({ text: q[1] ?? q[2] ?? q[3] ?? q[4], delivery: att.delivery, position: q.index!, speaker: att.speaker, addressee: att.addressee, genderHint: att.genderHint });
    lastEnd = q.index! + q[0].length;
  }
  // Also accept line-oriented NAME (cue): unquoted text, but never interpret action headings as speakers.
  let rowOffset = 0;
  for (const row of source.split("\n")) {
    const offset = rowOffset;
    rowOffset += row.length + 1;
    if (quotes.some(q => q.index! >= offset && q.index! < rowOffset)) continue;
    const m = row.trim().match(/^([\p{L}][\p{L}\p{N} .'-]*?)\s*(\([^)]*\))?\s*:\s*(\S.*)$/u);
    if (!m) continue;
    const canon = castNorm.find(c => c.forms.some(f => f.toLowerCase() === m[1].trim().toLowerCase()));
    if (canon) events.push({ text: m[3], delivery: m[2] ?? "", position: offset, speaker: canon.name });
  }
  events.sort((a, b) => a.position - b.position);
  return events;
}

/** Eyeline/reverse-shot addressee pass (staging only — does NOT influence speaker resolution, so it can
 * never mask a speaker conflict). Priority: explicit addressee from prose → the single partner in a
 * two-hander → in a 3+ scene, the person just speaking (natural reply target). A line with no prior
 * speaker and no explicit addressee stays undefined = addressed to the group. */
function applyAddresseePass(events: SpeechEvent[], castNorm: CastNorm[]): void {
  const names = castNorm.map(c => c.name);
  let prevSpeaker: string | undefined;
  for (const e of events) {
    if (!e.addressee) {
      if (names.length === 2 && e.speaker) e.addressee = names.find(n => n !== e.speaker);
      else if (prevSpeaker && prevSpeaker !== e.speaker) e.addressee = prevSpeaker;
    }
    if (e.addressee && (!names.includes(e.addressee) || e.addressee === e.speaker)) e.addressee = undefined;
    if (e.speaker) prevSpeaker = e.speaker;
  }
}

/** Resolve `name` (canonical OR alias, case-insensitive) to the canonical cast NAME, else undefined. */
function canonicalName(name: string | undefined, castNorm: CastNorm[]): string | undefined {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return undefined;
  return castNorm.find(c => c.forms.some(f => f.toLowerCase() === n))?.name;
}

/** The exact legacy conflict message. Kept verbatim so the fail-closed contract is unchanged. */
const ATTRIBUTION_CONFLICT =
  "Dialogue attribution conflict: quoted speech has no unambiguous cast speaker. Rebuild boards with explicit NAME (delivery): quoted line.";

/** Fail-closed extractor (Stage 132/133/134 behaviour): every quoted line must resolve deterministically
 * to a unique cast speaker, otherwise it THROWS. Used by pure callers and by every synchronous test. */
export function extractSpokenLines(source: string, cast: CastInput[] = []): SpokenLine[] {
  const castNorm = normalizeCast(cast);
  const events = buildSpeechEvents(source, castNorm);
  // Deterministic resolution runs in source order so alternation / turn-taking see prior speakers.
  resolveSpeakers(events, castNorm);
  applyAddresseePass(events, castNorm);
  return events.map(e => {
    if (!e.speaker) throw new Error(ATTRIBUTION_CONFLICT);
    return { speaker: e.speaker, text: e.text, delivery: cleanDelivery(e.delivery, castNorm), addressee: e.addressee };
  });
}

/** One repair round for lines the deterministic pass could not attribute. Given the cast and the exact
 * unresolved quoted lines (with preceding context), it returns an explicit speaker (and optional delivery
 * / addressee) per line id. It NEVER rewrites the spoken text — only who says it. */
export type DialogueRepairFn = (input: {
  cast: string[];
  lines: { id: number; text: string; contextBefore: string }[];
}) => Promise<Array<{ id: number; speaker: string; delivery?: string; addressee?: string }>>;

/** Stage 135 — RESOLVING extractor. Runs the same deterministic attribution first; when quoted lines are
 * still unattributed it makes ONE optional repair round (deterministic context is exhausted, so the caller
 * supplies an LLM disambiguator) that forces an explicit speaker per line, then re-resolves. A hard,
 * INFORMATIVE conflict is thrown ONLY when even the repair cannot attribute a line — the normal path
 * succeeds and boards rebuild. The spoken text/order is never changed; only the speaker is filled in. */
export async function extractSpokenLinesResilient(
  source: string, cast: CastInput[] = [], opts: { repair?: DialogueRepairFn } = {},
): Promise<SpokenLine[]> {
  const castNorm = normalizeCast(cast);
  const names = castNorm.map(c => c.name);
  const events = buildSpeechEvents(source, castNorm);
  resolveSpeakers(events, castNorm);
  const unresolved = events.filter(e => !e.speaker);
  if (unresolved.length && opts.repair) {
    const lines = unresolved.map((e, i) => ({
      id: i,
      text: e.text,
      contextBefore: source.slice(0, e.position).slice(-200).replace(/\s+/g, " ").trim(),
    }));
    const fixes = await opts.repair({ cast: names, lines });
    const byId = new Map((fixes ?? []).map(f => [f.id, f]));
    unresolved.forEach((e, i) => {
      const fix = byId.get(i);
      if (!fix) return;
      const speaker = canonicalName(fix.speaker, castNorm);
      if (!speaker) return; // ignore an out-of-cast guess; the hard-fail below reports it precisely
      e.speaker = speaker;
      if (fix.delivery && !e.delivery.trim()) e.delivery = fix.delivery;
      const addressee = canonicalName(fix.addressee, castNorm);
      if (addressee && addressee !== speaker) e.addressee = addressee;
    });
    // A newly-fixed speaker can let two-hander alternation resolve its neighbours — re-run resolution once.
    resolveSpeakers(events, castNorm);
  }
  applyAddresseePass(events, castNorm);
  const stillUnresolved = events.filter(e => !e.speaker);
  if (stillUnresolved.length) {
    const first = stillUnresolved[0];
    throw new Error(
      `Dialogue attribution conflict: could not assign a unique speaker to ${JSON.stringify(first.text)}` +
      ` (${stillUnresolved.length} line(s) unresolved). Candidates: ${names.join(", ") || "none"}.` +
      ` Rebuild boards with explicit NAME (delivery): "quoted line".`,
    );
  }
  return events.map(e => ({ speaker: e.speaker!, text: e.text, delivery: cleanDelivery(e.delivery, castNorm), addressee: e.addressee }));
}

export function estimatedSpeechSeconds(line: SpokenLine): number {
  const words = line.text.trim().split(/\s+/u).filter(Boolean).length;
  const slow = /slow|whisper|hesitan|pause|медлен|ш[её]пот|пауза/iu.test(line.delivery);
  return Math.max(words / (slow ? 1.6 : 2), [...line.text].length / (slow ? 10 : 13)) + 0.6;
}

/** Split a single over-long clause (one with no internal punctuation to break on) into the fewest
 * word-group fragments that each fit the 6s planning budget. Lossless: every character and the
 * original order are preserved (each whitespace run is attached to exactly one fragment); a lone
 * word that still exceeds the budget is kept whole rather than truncated or spoken faster. */
function splitClauseByWords(line: SpokenLine, clause: string): string[] {
  const tokens = clause.match(/\s*\S+\s*/gu);
  if (!tokens || tokens.join("") !== clause) return [clause];
  const parts: string[] = [];
  let part = "";
  for (const token of tokens) {
    if (part && estimatedSpeechSeconds({ ...line, text: part + token }) > 6) { parts.push(part); part = ""; }
    part += token;
  }
  if (part) parts.push(part);
  return parts.length ? parts : [clause];
}

/** Split at natural punctuation boundaries first; preserve every character and the original order.
 * A clause with no punctuation to break on that still exceeds the 6s budget is split losslessly at
 * word boundaries (never truncated, omitted or spoken faster), so no phrase is ever un-splittable
 * and the storyboard always builds instead of aborting.
 */
export function segmentSpeech(lines: SpokenLine[]): SpeechSegment[] {
  return lines.flatMap((line, index) => {
    const sourceId = `speech-${index + 1}`;
    const rawClauses = line.text.match(/[^.!?;,…—]+(?:[.!?;,…—]+\s*|$)/gu) ?? [line.text];
    if (rawClauses.join("") !== line.text) throw new Error("Dialogue segmentation conflict: punctuation cannot be split losslessly.");
    // Break any over-long unbroken clause into word-group fragments so every fragment fits a 4–6s
    // board; downstream balancing then fans them out across consecutive boards. Text stays verbatim.
    const clauses = rawClauses.flatMap(clause =>
      estimatedSpeechSeconds({ ...line, text: clause }) > 6 ? splitClauseByWords(line, clause) : [clause]);
    const chunks: string[] = [];
    let chunk = "";
    for (const clause of clauses) {
      if (chunk && estimatedSpeechSeconds({ ...line, text: chunk + clause }) > 6) { chunks.push(chunk); chunk = ""; }
      chunk += clause;
    }
    if (chunk) chunks.push(chunk);
    return chunks.map((text, part) => ({ ...line, text, sourceId, id: `${sourceId}.${part + 1}`, estimatedSec: estimatedSpeechSeconds({ ...line, text }) }));
  });
}

export interface StoryboardScriptScene { number: number; action: string | null; dialogue: string | null }
export function storyboardSource(episode: { script?: string | null; description?: string | null }, scenes: StoryboardScriptScene[], cast: CastInput[]) {
  // Stage 141 — the worker passes ENGLISH dialogue text in this `dialogue` field (translated upstream);
  // this builder preserves it verbatim and never translates, so the ledger text stays exactly as supplied.
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
      // Stage 152 — tag every line with its source scene number so scene openers are detectable downstream.
      return found.map(l => ({ ...l, scene: s.number }));
    })
    : extractSpokenLines(source, cast);
  const segments = segmentSpeech(speech);
  // Budget check uses the ORIGINAL lines (not the post-split segments): word-splitting adds a per-segment
  // baseline that must never, by itself, push a within-budget script over the planning limit.
  if (speech.reduce((sum, l) => sum + estimatedSpeechSeconds(l), 0) > 90)
    throw new Error("Dialogue duration conflict: original speech exceeds the 15 × 6s planning budget. No lines were omitted; approve a script/budget change separately.");
  return { source, segments, actionSource: ordered.length ? ordered.map(s => s.action ?? "").join("\n") : source };
}

/** Stage 135 — RESOLVING source builder. Mirrors {@link storyboardSource} but attributes speech through
 * {@link extractSpokenLinesResilient}, so ambiguous quoted speech is repaired to an explicit speaker and
 * boards rebuild instead of hard-failing. The spoken text/order is preserved verbatim; only who says each
 * line is filled in. A hard conflict is thrown only when even the repair round cannot attribute a line. */
export async function storyboardSourceResilient(
  episode: { script?: string | null; description?: string | null },
  scenes: StoryboardScriptScene[],
  cast: CastInput[],
  opts: { repair?: DialogueRepairFn } = {},
) {
  const ordered = [...scenes].sort((a, b) => a.number - b.number);
  const source = ordered.length
    ? ordered.map(s => `ACTION: ${s.action ?? ""}\n${s.dialogue ?? ""}`).join("\n\n")
    : (episode.script?.trim() || episode.description?.trim() || "");
  let speech: SpokenLine[];
  if (ordered.length) {
    speech = [];
    for (const s of ordered) {
      const text = s.dialogue?.trim() ?? "";
      const found = await extractSpokenLinesResilient(text, cast, opts);
      if (text && !found.length && !/^\[?(?:NO DIALOGUE|SILENCE|NON-VERBAL|БЕЗ ДИАЛОГА)\]?$/iu.test(text))
        throw new Error(`Source dialogue format conflict in scene ${s.number}: preserve explicit speaker attribution before splitting.`);
      // Stage 152 — tag every line with its source scene number so scene openers are detectable downstream.
      speech.push(...found.map(l => ({ ...l, scene: s.number })));
    }
  } else {
    speech = await extractSpokenLinesResilient(source, cast, opts);
  }
  const segments = segmentSpeech(speech);
  // Budget check uses the ORIGINAL lines (not the post-split segments): word-splitting adds a per-segment
  // baseline that must never, by itself, push a within-budget script over the planning limit.
  if (speech.reduce((sum, l) => sum + estimatedSpeechSeconds(l), 0) > 90)
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
