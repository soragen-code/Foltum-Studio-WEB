/** Stage 132 — validated shot/speech/camera data, confined to Storyboard. */
import { z } from "zod";
import {
  normalizeBoards, validateBoards, contentBoardBounds,
  STORYBOARD_MIN_BOARD_SEC, STORYBOARD_MAX_BOARD_SEC, STORYBOARD_TARGET_TOTAL_SEC,
  type RawBoard,
} from "@/lib/storyboard";
import { estimatedSpeechSeconds, hasActorTravel, type SpeechSegment } from "@/lib/storyboard-dialogue";
import { planSceneCoverage, resolveVisibleCast, buildShotSizeLine, buildOffScreenLine, type BoardCoverage } from "@/lib/board-coverage";

const speechSchema = z.object({ id: z.string(), sourceId: z.string(), speaker: z.string(), text: z.string(), delivery: z.string(), estimatedSec: z.number(), addressee: z.string().optional() });
const directionSchema = z.object({
  // 132 = original two-hander plan; 134 adds N>=3 multi-speaker addressee/eyeline data. Both parse so
  // boards persisted before Stage 134 still read back (they simply carry no per-line addressee).
  version: z.union([z.literal(132), z.literal(134)]),
  cameraMode: z.enum(["LOCKED_OFF", "TRACKING"]),
  travelEvidence: z.string(),
  actionEnglish: z.string(),
  // Stage 134 adds group / two_shot / three_shot coverage for scenes with three or more speakers.
  shot: z.enum(["action", "medium", "close_up", "over_shoulder", "listener_reverse", "two_shot", "three_shot", "group"]),
  focus: z.string(), listener: z.string(),
  /** Stage 134 — the cast member the active (last) speaker addresses in this board = reverse-shot / eyeline
   * target. Optional (default "") so older 132 boards without it still parse. */
  addressee: z.string().optional().default(""),
  cast: z.array(z.string()),
  speech: z.array(speechSchema),
  /** Stage 138 — set when a tracking/travelling camera was requested but could not be justified by literal
   * source movement, so the board was deterministically degraded to a static locked-off camera instead of
   * hard-failing. Empty means no degradation. Optional (default "") so older boards still parse. */
  cameraDegradedReason: z.string().optional().default(""),
});
export type BoardDirection = z.infer<typeof directionSchema>;
export interface RawDirectedBoard extends RawBoard {
  speechIds?: string[];
  actionEnglish?: string;
  /** Exact substring of source ACTION (not a spoken line). Empty = static/gesture. */
  travelEvidence?: string;
  shot?: BoardDirection["shot"];
  listener?: string;
}

export function readBoardDirection(json?: string | null): BoardDirection | null {
  if (!json) return null;
  const plan = directionSchema.parse(JSON.parse(json));
  if (plan.cameraMode !== (hasActorTravel(plan.travelEvidence) ? "TRACKING" : "LOCKED_OFF"))
    throw new Error("Storyboard camera data conflict; rebuild boards.");
  return plan;
}

/**
 * Stage 139 — deterministic speech-ID reconciliation. The LLM split (and, upstream, an LLM repair round)
 * can omit, duplicate, re-order or invent speech IDs. The dialogue-integrity invariant — every source ID
 * appears EXACTLY ONCE, in source order, without omissions or paraphrases — must therefore hold by
 * CONSTRUCTION, not merely be caught by a hard-fail after the fact.
 *
 * We keep the model's per-board chunk SHAPE (how many spoken lines each board carries, and which boards are
 * silent) as a pacing hint, and refill those slots with the AUTHORITATIVE source IDs strictly in source
 * order. Because segments carry their own speaker/delivery/addressee, per-line attribution travels with the
 * ID, and the verbatim text is always restored downstream from the ledger by ID (never from LLM prose).
 *   - A plan that was already a valid in-order permutation reconciles to itself (no-op).
 *   - A broken plan (dropped / duplicated / re-ordered / hallucinated IDs) is repaired losslessly.
 *   - Lines the model never placed are appended to the last spoken board; balanceBoardCount then fans out
 *     any overflow across consecutive boards, so nothing is truncated or sped up.
 * The integrity check in finalizeDirectedBoards stays as the LAST line of defence for any caller that skips
 * this reconciliation.
 */
export function reconcileSpeechIds(raw: RawDirectedBoard[], segments: SpeechSegment[]): RawDirectedBoard[] {
  if (!Array.isArray(raw)) return raw;
  const sourceOrder = segments.map(s => s.id);
  const valid = new Set(sourceOrder);
  const boards: RawDirectedBoard[] = raw.map(b => ({ ...b, speechIds: [...(b.speechIds ?? [])] }));
  if (!boards.length) return boards; // no boards to attach speech to — the count check reports it later.
  // 1) Per-board slot count = how many FIRST-occurrence valid IDs the model placed on that board. Duplicates,
  //    out-of-cast/unknown IDs and repeats on later boards contribute nothing (each source ID counts once).
  const consumed = new Set<string>();
  const slots = boards.map(b => {
    let n = 0;
    for (const id of b.speechIds ?? []) if (valid.has(id) && !consumed.has(id)) { consumed.add(id); n++; }
    return n;
  });
  // 2) Source IDs the model never placed are appended to the last spoken board (or board 0 if the model
  //    produced no speech at all). Overflow this creates is redistributed by balanceBoardCount afterwards.
  const missing = sourceOrder.length - slots.reduce((s, n) => s + n, 0);
  if (missing > 0) {
    let target = slots.length - 1;
    while (target > 0 && slots[target] === 0) target--;
    slots[target] += missing;
  }
  // 3) Refill every slot with source IDs strictly in source order — guarantees exact-once AND source order.
  let cursor = 0;
  for (let i = 0; i < boards.length; i++) {
    boards[i].speechIds = sourceOrder.slice(cursor, cursor + slots[i]);
    cursor += slots[i];
  }
  return boards;
}

/**
 * Stage 148 — deterministic per-board-budget balancing with a CONTENT-DERIVED board count. The board count
 * is NOT forced into a fixed 12–15 window: it follows the content (speech-segment count + total spoken time
 * at 4–6s/board + the silent establishing/action shots the scene needs). A sparse scene may legitimately
 * yield fewer than 12 boards and a dialogue-heavy one more than 15 — neither is an error, and speech is
 * NEVER truncated, omitted, re-ordered or sped up. We only reshape the plan so no single board holds more
 * than one 4–6s clip can carry:
 *   - Phase 1 (Stage 137): distribute OVERFLOWING speech — any board whose lines exceed one board's 4–6s
 *     budget (or the two-line cap) keeps a fitting prefix and pushes the remaining source IDs onto a new
 *     board inserted right after; a long run of speech fans out across as many consecutive boards as needed.
 *     This is what grows the count to match dialogue-heavy content.
 *   - Merge guard (content-derived ceiling only): if the model pathologically OVER-splits beyond a generous
 *     content-derived ceiling (contentBoardBounds().ceiling), fold adjacent boards that fit losslessly into
 *     one (≤2 short spoken lines, ≤ MAX_BOARD_SEC, neither travelling). This never runs for normal plans and
 *     never truncates speech — it only trims runaway over-splitting. There is NO merge-down to a fixed max
 *     and NO split-up to a fixed min.
 * Durations are re-fit into [4,6]s summing toward ~90s (soft target; a short scene is simply shorter).
 *
 * Runs BEFORE finalizeDirectedBoards so the ledger's exact-once speech-ID check still sees every segment.
 */
export function balanceBoardCount(raw: RawDirectedBoard[], segments: SpeechSegment[]): RawDirectedBoard[] {
  if (!Array.isArray(raw)) return raw;
  // Stage 139 — reconcile the model's speech-ID allocation FIRST, so the dialogue-integrity invariant (every
  // source ID exactly once, in source order) holds by construction before we balance count/budget. This also
  // clones the boards (and their speechIds arrays), so the caller's plan is never mutated in place.
  const boards: RawDirectedBoard[] = reconcileSpeechIds(raw, segments);

  const ledger = new Map(segments.map(s => [s.id, s]));
  const segSec = (id: string) => { const s = ledger.get(id); return s ? estimatedSpeechSeconds(s) : 0; };
  const speechSec = (b: RawDirectedBoard) => (b.speechIds ?? []).reduce((sum, id) => sum + segSec(id), 0);
  const travels = (b: RawDirectedBoard) => hasActorTravel(b.travelEvidence ?? "");
  const hasSpeech = (b: RawDirectedBoard) => (b.speechIds ?? []).length > 0;
  // A board overflows when it holds more than two lines OR more spoken time than a single 4–6s board can carry.
  const overflows = (b: RawDirectedBoard) => (b.speechIds?.length ?? 0) > 2 || speechSec(b) > STORYBOARD_MAX_BOARD_SEC;
  const joinAction = (a?: string, c?: string) => {
    const parts = [a?.trim(), c?.trim()].filter(Boolean) as string[];
    return parts.filter((p, i) => parts.indexOf(p) === i).join(". ") || undefined;
  };

  // Stage 148 — content-derived generous ceiling on the board count (never a fixed range). It sits well
  // above what the content needs, so it only trims pathological LLM over-splitting via lossless merges.
  const { ceiling: contentMaxBoards } = contentBoardBounds(segments.map(s => estimatedSpeechSeconds(s)));

  // Fast path: no board overflows its 4–6s budget AND the count is not a pathological over-split — leave
  // the model's plan untouched. The count is content-derived, so ANY count at or below the ceiling passes,
  // including a sparse scene well under 12 or a dialogue-heavy scene well over 15.
  if (boards.length <= contentMaxBoards && !boards.some(overflows))
    return boards;

  // ── PHASE 1 (Stage 137): distribute overflowing speech onto FOLLOWING boards ──
  // For any board whose lines exceed one board's 4–6s budget (or its two-line cap), keep the maximal
  // fitting prefix and push the remaining source IDs onto a new board inserted right after — never
  // speeding up, omitting or re-ordering a single word. The new board itself is re-examined next
  // iteration, so a very long run of speech fans out across as many consecutive boards as it needs.
  let g1 = segments.length * 4 + boards.length + 8;
  for (let i = 0; i < boards.length && g1-- > 0; i++) {
    const b = boards[i];
    if (!overflows(b)) continue;
    const ids = b.speechIds ?? [];
    // Greedily keep at least one line, up to two, while the spoken time stays within a single board.
    let keep = 0, sec = 0;
    for (const id of ids) {
      const s = segSec(id);
      if (keep >= 1 && (keep >= 2 || sec + s > STORYBOARD_MAX_BOARD_SEC)) break;
      sec += s; keep++;
    }
    const head = ids.slice(0, keep), tail = ids.slice(keep);
    if (!tail.length) continue; // nothing to move (defensive; a single line is always ≤ MAX by construction)
    const firstTail = ledger.get(tail[0]);
    boards[i] = { ...b, speechIds: head, durationSec: null };
    // The tail continues the SAME beat/action; its active speaker drives a fresh reverse-shot / eyeline.
    boards.splice(i + 1, 0, {
      ...b, speechIds: tail, durationSec: null,
      shot: firstTail?.addressee ? "listener_reverse" : (b.shot ?? "over_shoulder"),
      listener: firstTail?.addressee || b.listener,
    });
  }

  // ── MERGE guard: pathological over-split only (content-derived ceiling) ──────
  // The board count is content-derived, so this does NOT merge down to a fixed max. It only fires when the
  // model over-splits beyond the generous content ceiling, folding the adjacent pair that fits inside ONE
  // board (≤2 spoken lines, ≤ MAX_BOARD_SEC of speech, neither travelling) with the smallest combined
  // speech time. It never truncates speech; a normal sparse OR dialogue-heavy plan never triggers it.
  let guard = boards.length * 4;
  while (boards.length > contentMaxBoards && guard-- > 0) {
    let best = -1, bestSec = Infinity;
    for (let i = 0; i < boards.length - 1; i++) {
      const a = boards[i], b = boards[i + 1];
      if (travels(a) || travels(b)) continue;
      if ((a.speechIds?.length ?? 0) + (b.speechIds?.length ?? 0) > 2) continue;
      const combined = speechSec(a) + speechSec(b);
      if (combined > STORYBOARD_MAX_BOARD_SEC) continue;
      if (combined < bestSec) { bestSec = combined; best = i; }
    }
    if (best < 0) break; // nothing further mergeable without truncation
    const a = boards[best], b = boards[best + 1];
    const bSpeaks = hasSpeech(b); // the active (later) speaker drives the reverse-shot / eyeline
    const merged: RawDirectedBoard = {
      ...a,
      speechIds: [...(a.speechIds ?? []), ...(b.speechIds ?? [])],
      actionOrDialogue: [a.actionOrDialogue, b.actionOrDialogue].map(t => (t ?? "").trim()).filter(Boolean).join("\n"),
      actionEnglish: joinAction(a.actionEnglish, b.actionEnglish),
      travelEvidence: "",
      shot: (bSpeaks ? b.shot : a.shot) ?? a.shot ?? b.shot,
      listener: (bSpeaks ? b.listener : a.listener) || a.listener || b.listener,
      durationSec: null,
    };
    boards.splice(best, 2, merged);
  }

  // Stage 148 — NO split-up to a fixed minimum: a short/sparse scene keeps its small board count. The count
  // is content-derived (Phase 1 already grew it to fit dialogue-heavy content, and each board is within its
  // 4–6s budget by construction), so a plan with fewer than 12 boards is valid and never padded with filler.

  // ── Re-fit durations into [4,6]s, summing toward ~90s (each segment is ≤6s by construction). ──
  const dur = boards.map(b => Math.min(STORYBOARD_MAX_BOARD_SEC, Math.max(STORYBOARD_MIN_BOARD_SEC, Math.ceil(speechSec(b)))));
  let total = dur.reduce((s, d) => s + d, 0);
  for (let i = 0; i < dur.length && total < STORYBOARD_TARGET_TOTAL_SEC; i++) {
    while (dur[i] < STORYBOARD_MAX_BOARD_SEC && total < STORYBOARD_TARGET_TOTAL_SEC) { dur[i]++; total++; }
  }
  return boards.map((b, i) => ({ ...b, durationSec: dur[i] }));
}

/** Preserve the ledger exactly: model references immutable IDs, never rewrites spoken text. */
export function finalizeDirectedBoards(raw: RawDirectedBoard[], segments: SpeechSegment[], cast: string[], actionSource: string) {
  // Stage 148 — the board count is content-derived; there is no fixed 12–15 window to enforce. Only a
  // genuinely empty plan is a conflict (nothing to render). Speech is never truncated to satisfy a count.
  if (!Array.isArray(raw) || raw.length < 1)
    throw new Error(`Storyboard planning conflict: at least one board is required. No boards or dialogue were truncated.`);
  const ledger = new Map(segments.map(s => [s.id, s]));
  const used: string[] = [];
  const plannedDirections = raw.map((b, index): BoardDirection => {
    const speech = (b.speechIds ?? []).map(id => {
      const segment = ledger.get(id);
      if (!segment) throw new Error(`Unknown source speech ID at board ${index + 1}`);
      used.push(id); return segment;
    });
    if (speech.length > 2) throw new Error(`Board ${index + 1}: at most two speech segments; spread them across consecutive boards.`);
    const duration = b.durationSec ?? 6;
    if (!Number.isInteger(duration) || duration < 4 || duration > 6)
      throw new Error(`Board ${index + 1}: duration conflict (must stay 4–6s).`);
    if (speech.reduce((sum, line) => sum + estimatedSpeechSeconds(line), 0) > duration)
      throw new Error(`Board ${index + 1}: dialogue exceeds its ${duration}s estimated budget; distribute source IDs over consecutive boards, never speed up or omit words.`);
    const evidence = b.travelEvidence?.trim() ?? "";
    if (evidence && !actionSource.includes(evidence)) throw new Error(`Board ${index + 1}: movement evidence is not in source action.`);
    if (!speech.length && /["«“]/u.test(b.actionOrDialogue)) throw new Error(`Board ${index + 1}: quoted dialogue requires source speech IDs; no invented or silent dialogue.`);
    const action = b.actionEnglish?.trim() || "Natural character reactions consistent with the opening frame.";
    if (/\b(?:camera|zoom|push.in|pull.out|pan|tilt|orbit|refram|dolly)\b/i.test(action))
      throw new Error(`Board ${index + 1}: actionEnglish must contain actor action only, not camera directions.`);
    if (/["«“]/u.test(action)) throw new Error(`Board ${index + 1}: put speech in source IDs, not actionEnglish.`);
    // Stage 138 — TRACKING is allowed ONLY when the board's action literally travels AND that locomotion is
    // backed by a literal excerpt of the source action. When they disagree we DETERMINISTICALLY DEGRADE the
    // board to a static locked-off camera and record why, instead of hard-failing planning. (A movement
    // excerpt that is not present in the source at all is a genuine data conflict and still throws above.)
    const actionTravels = hasActorTravel(action);
    const evidenceTravels = hasActorTravel(evidence);
    let cameraMode: BoardDirection["cameraMode"];
    let travelEvidence = evidence;
    let cameraDegradedReason = "";
    if (actionTravels && evidenceTravels) {
      cameraMode = "TRACKING"; // real, source-backed locomotion — the camera may follow the walking actors.
    } else if (actionTravels && !evidenceTravels) {
      // Travelling action with no literal source movement evidence → static, not a conflict.
      cameraMode = "LOCKED_OFF";
      cameraDegradedReason = "Travelling action has no literal source movement evidence; camera degraded to static locked-off.";
    } else if (!actionTravels && evidenceTravels) {
      // A stationary beat must not inherit a tracking cue from another board → drop the stale evidence, go static.
      cameraMode = "LOCKED_OFF"; travelEvidence = "";
      cameraDegradedReason = "Board action is stationary; inherited movement evidence dropped and camera degraded to static locked-off.";
    } else {
      cameraMode = "LOCKED_OFF"; // dialogue / freeze / gesture — always static.
    }
    const firstSpeaker = speech[0]?.speaker ?? "";
    if (speech.some(s => !cast.includes(s.speaker))) throw new Error("Source speaker does not match the episode cast.");
    // Every per-line addressee (eyeline target) must be a real, DIFFERENT cast member — no self-address.
    for (const s of speech)
      if (s.addressee && (!cast.includes(s.addressee) || s.addressee === s.speaker))
        throw new Error(`Board ${index + 1}: invalid dialogue addressee (must be another cast member).`);
    // The ACTIVE (last) line drives the reverse-shot / eyeline. Supports 3+ speakers: the reverse target is
    // the person that line is spoken to, not a fixed single partner. Falls back to the model's listener, then
    // (only in a two-hander) the other cast member. In a 3+ scene with no cue it stays empty (group framing).
    const activeSpeaker = speech.at(-1)?.speaker ?? firstSpeaker;
    const addressee = speech.at(-1)?.addressee || b.listener || (cast.length === 2 ? cast.find(c => c !== activeSpeaker) : "") || "";
    const listener = addressee;
    if (listener && (!cast.includes(listener) || listener === activeSpeaker)) throw new Error("Invalid dialogue listener mapping.");
    const shot = speech.length ? (b.shot && b.shot !== "action" ? b.shot : "over_shoulder") : "action";
    return directionSchema.parse({
      version: 134, cameraMode,
      travelEvidence, actionEnglish: action, shot,
      focus: shot === "listener_reverse" ? listener : activeSpeaker,
      listener, addressee, cast: [...cast], speech, cameraDegradedReason,
    });
  });
  // Stage 146 — deterministic CHARACTER-FORWARD scene coverage: board 1 is a WIDE ESTABLISHING of the whole cast
  // (scene-opening establishing); every later dialogue board stays built around the characters — single / OTS /
  // reverse on the speech, a mid-scene "group" wide always degrades to OTS / medium. Only shot/focus change.
  const directions = planSceneCoverage(plannedDirections, raw.map(b => b.actionOrDialogue));
  if (JSON.stringify(used) !== JSON.stringify(segments.map(s => s.id)))
    throw new Error("Dialogue integrity conflict: source lines must appear exactly once, in source order, without omissions or paraphrases.");
  // Parts of a long utterance must occupy consecutive boards, not separated by silent inserts.
  for (let i = 1; i < directions.length; i++) {
    const prev = directions[i - 1].speech.at(-1);
    if (!prev) continue;
    const nextSegment = segments[segments.findIndex(s => s.id === prev.id) + 1];
    if (nextSegment?.sourceId === prev.sourceId && directions[i].speech[0]?.id !== nextSegment.id)
      throw new Error("Dialogue continuity conflict: parts of one utterance require consecutive boards.");
  }
  const boards = normalizeBoards(raw.map((b, i) => ({
    ...b,
    // No model-written dialogue survives: exact original source bytes are persisted instead.
    actionOrDialogue: directions[i].speech.length
      ? directions[i].speech.map(s => `${s.speaker}${s.delivery ? ` (${s.delivery})` : ""}: "${s.text}"`).join("\n")
      : b.actionOrDialogue,
    motion: directions[i].actionEnglish,
  })));
  const problems = validateBoards(boards);
  if (problems.length) throw new Error(problems.join("; "));
  if (boards.length !== raw.length) throw new Error("Empty board conflict; no action may be discarded.");
  return boards.map((b, i) => ({ ...b, directionJson: JSON.stringify(directions[i]) }));
}

/**
 * Stage 143 — shot context with a HARD visible cast. `boardPosInScene` (0-based board index) lets board 1 resolve
 * as the wide establishing shot; `coverage` may be passed pre-computed by the worker (same resolver).
 */
export function boardShotContext(plan: BoardDirection, boardPosInScene = 1, coverage?: BoardCoverage, continues = false): string {
  const cov = coverage ?? resolveVisibleCast(plan, boardPosInScene, plan.cast, "");
  // Stable screen sides for any number of characters (spatial coherence across boards). Positions 1/2 are
  // the classic 180-degree pair; a third sits center mid-ground; anyone beyond keeps their established side.
  const seat = (i: number) =>
    i === 0 ? "screen-left, looking toward screen-right" :
    i === 1 ? "screen-right, looking toward screen-left" :
    i === 2 ? "center mid-ground between them, turning toward whoever is addressed" :
    "retain the established background position on their established side";
  // Staging positions are listed for the VISIBLE cast only (positions are indexed by the full-cast order so the
  // established sides stay stable across boards); the rest are named once as OFF-SCREEN.
  const cast = plan.cast.map((name, i) => cov.visible.includes(name) ? `${name}: staging position ${i + 1}, ${seat(i)}` : "").filter(Boolean).join("; ");
  const speakers = new Set(plan.speech.map(s => s.speaker));
  const reacting = plan.cast.filter(n => !speakers.has(n) && cov.visible.includes(n));
  // Per-line eyeline: each speaker looks at the real person that line is spoken to (their reverse target).
  const eyelines = plan.speech
    .map(s => `${s.speaker} → ${s.addressee || plan.listener || "the group"} (eyeline to ${s.addressee || plan.listener || "the addressed partner"}'s established side)`)
    .join("; ");
  return [
    continues
      ? `ACTOR BLOCKING: ${plan.actionEnglish} CONTINUE this action from the exact moment the immediately previous board left off — do NOT restart it from a neutral pose. Every pose, body contact, who-touches-whom and prop already established carries over unchanged; only the camera angle, height, lens and shot size change (a cut to another vantage of the same instant).`
      : `OPENING ACTOR BLOCKING: ${plan.actionEnglish} Establish this action clearly; the boards that follow will CONTINUE it from where this one leaves off, so keep poses, body contact and props readable.`,
    buildShotSizeLine(cov),
    `VISIBLE CAST STAGING: ${cast}. All cast remain in the location unless a scripted exit is shown; off-screen is NOT disappearance, but off-screen characters are NOT drawn.`,
    buildOffScreenLine(cov),
    "AXIS: maintain a coherent 180-degree layout for the whole group; every character keeps the SAME relative screen position and side established by the seating/standing arrangement across every board. When the shot reverses to a different addressee, change only the framing and eyeline to that person's established side — never swap anyone's established side and never teleport a character; nobody turns toward the screen or looks into the lens. Preserve action and location geometry continuity.",
    plan.speech.length ? `DIALOGUE SHOT: ${plan.shot.replace(/_/g, " ")}; focus ${plan.focus}; listener ${plan.listener || "the established partner"}. EYELINES: ${eyelines}. ${reacting.length ? `PRESENT AND REACTING (silent, must not speak another's line): ${reacting.join(", ")}. ` : ""}The framing of this board is FIXED by the SHOT SIZE line above (its shot size and its exact cast); no internal shot changes. Every named character remains in the scene even when off-screen.` : "",
    "Different angles and shot sizes change only BETWEEN boards by hard cut, never inside the animation. Keep the same master/region-plate geometry authority, walls (never columns instead), and bench back flush against its wall.",
  ].filter(Boolean).join("\n");
}
