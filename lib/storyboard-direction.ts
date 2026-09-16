/** Stage 132 — validated shot/speech/camera data, confined to Storyboard. */
import { z } from "zod";
import {
  normalizeBoards, validateBoards,
  STORYBOARD_MIN_BOARDS, STORYBOARD_MAX_BOARDS,
  STORYBOARD_MIN_BOARD_SEC, STORYBOARD_MAX_BOARD_SEC, STORYBOARD_TARGET_TOTAL_SEC,
  type RawBoard,
} from "@/lib/storyboard";
import { estimatedSpeechSeconds, hasActorTravel, type SpeechSegment } from "@/lib/storyboard-dialogue";

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
 * Stage 136 + 137 — deterministic board-count AND per-board-budget balancing so planning CONVERGES on the
 * hard 12–15 window with every board inside 4–6s, instead of hard-failing. The LLM split can naively yield
 * a count outside 12–15, OR pack a board with more spoken time than a single 4–6s clip can carry. We
 * redistribute WITHOUT ever truncating, omitting, re-ordering or speeding up speech, in three phases:
 *   - Phase 1 (Stage 137): distribute OVERFLOWING speech — any board whose lines exceed one board's 4–6s
 *     budget (or the two-line cap) keeps a fitting prefix and pushes the remaining source IDs onto a new
 *     board inserted right after; a long run of speech fans out across as many consecutive boards as needed.
 *   - Phase 2 (Stage 136) too many boards (> MAX): merge adjacent short/static boards — pack up to two short
 *     spoken lines into one board while staying inside 4–6s; every speech ID is preserved, in source order,
 *     with its NAME (delivery): "line" attribution. Boards with real scripted travel are never merged.
 *   - Phase 3 (Stage 136) too few boards (< MIN): split a two-line dialogue board into one line each (a shot
 *     change at the cut), or split the longest static action board into two, without inventing speech.
 * The phases run in sequence (split-up then merge-down then split-up), so they converge without oscillating.
 * Durations are re-fit into [4,6]s summing toward ~90s. Only genuinely unfittable material (more speech than
 * MAX boards × 6s can hold) throws an informative conflict describing how much speech there is.
 *
 * Runs BEFORE finalizeDirectedBoards so the ledger's exact-once speech-ID check still sees every segment.
 */
export function balanceBoardCount(raw: RawDirectedBoard[], segments: SpeechSegment[]): RawDirectedBoard[] {
  if (!Array.isArray(raw)) return raw;
  // Clone boards (and their speechIds arrays) so the caller's plan is never mutated in place.
  const boards: RawDirectedBoard[] = raw.map(b => ({ ...b, speechIds: [...(b.speechIds ?? [])] }));

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

  // Fast path: already valid on EVERY axis (count in range AND no board overflows its budget) — leave the
  // model's plan untouched, exactly as before. A count-valid plan with an over-budget board still balances.
  if (boards.length >= STORYBOARD_MIN_BOARDS && boards.length <= STORYBOARD_MAX_BOARDS && !boards.some(overflows))
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

  // ── MERGE: too many boards ──────────────────────────────────────────────────
  // Pick the adjacent pair that fits inside ONE board (≤2 spoken lines, ≤ MAX_BOARD_SEC of speech,
  // neither travelling) with the smallest combined speech time, and fold them together.
  let guard = boards.length * 4;
  while (boards.length > STORYBOARD_MAX_BOARDS && guard-- > 0) {
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

  // ── SPLIT: too few boards ───────────────────────────────────────────────────
  guard = STORYBOARD_MAX_BOARDS * 4;
  while (boards.length < STORYBOARD_MIN_BOARDS && guard-- > 0) {
    // Prefer splitting a two-line dialogue board into one line each — a genuine shot change at the cut.
    const twoLine = boards.findIndex(b => (b.speechIds?.length ?? 0) === 2 && !travels(b));
    if (twoLine >= 0) {
      const b = boards[twoLine];
      const [id1, id2] = b.speechIds!;
      const seg2 = ledger.get(id2);
      const first: RawDirectedBoard = { ...b, speechIds: [id1], durationSec: null };
      const second: RawDirectedBoard = {
        ...b, speechIds: [id2], durationSec: null,
        shot: seg2?.addressee ? "listener_reverse" : (b.shot ?? "over_shoulder"),
        listener: seg2?.addressee || b.listener,
      };
      boards.splice(twoLine, 1, first, second);
      continue;
    }
    // Otherwise split the longest static (no-speech, no-travel) action board into two identical halves.
    let longest = -1, longestLen = -1;
    for (let i = 0; i < boards.length; i++) {
      const b = boards[i];
      if ((b.speechIds?.length ?? 0) !== 0 || travels(b)) continue;
      const len = (b.actionOrDialogue ?? "").length;
      if (len > longestLen) { longestLen = len; longest = i; }
    }
    if (longest >= 0) {
      const b = boards[longest];
      boards.splice(longest, 1, { ...b, durationSec: null }, { ...b, durationSec: null });
      continue;
    }
    break; // nothing splittable without inventing speech
  }

  // ── Still outside the window → genuinely unfittable material. ────────────────
  if (boards.length < STORYBOARD_MIN_BOARDS || boards.length > STORYBOARD_MAX_BOARDS) {
    const totalSpeechSec = segments.reduce((sum, s) => sum + estimatedSpeechSeconds(s), 0);
    throw new Error(
      `after balancing, ${boards.length} boards remain, outside the required ${STORYBOARD_MIN_BOARDS}–${STORYBOARD_MAX_BOARDS}. ` +
      `This episode carries ~${Math.round(totalSpeechSec)}s of dialogue across ${segments.length} speech segments, which cannot ` +
      `be packed into ${STORYBOARD_MAX_BOARDS} boards of ${STORYBOARD_MIN_BOARD_SEC}–${STORYBOARD_MAX_BOARD_SEC}s without ` +
      `truncating speech. Shorten or split the script, or approve a longer board budget. No boards or dialogue were truncated.`,
    );
  }

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
  if (!Array.isArray(raw) || raw.length < STORYBOARD_MIN_BOARDS || raw.length > STORYBOARD_MAX_BOARDS)
    throw new Error(`Storyboard planning conflict: exactly ${STORYBOARD_MIN_BOARDS}–${STORYBOARD_MAX_BOARDS} boards required. No boards or dialogue were truncated.`);
  const ledger = new Map(segments.map(s => [s.id, s]));
  const used: string[] = [];
  const directions = raw.map((b, index): BoardDirection => {
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

export function boardShotContext(plan: BoardDirection): string {
  // Stable screen sides for any number of characters (spatial coherence across boards). Positions 1/2 are
  // the classic 180-degree pair; a third sits center mid-ground; anyone beyond keeps their established side.
  const seat = (i: number) =>
    i === 0 ? "screen-left, looking toward screen-right" :
    i === 1 ? "screen-right, looking toward screen-left" :
    i === 2 ? "center mid-ground between them, turning toward whoever is addressed" :
    "retain the established background position on their established side";
  const cast = plan.cast.map((name, i) => `${name}: staging position ${i + 1}, ${seat(i)}`).join("; ");
  const speakers = new Set(plan.speech.map(s => s.speaker));
  const reacting = plan.cast.filter(n => !speakers.has(n));
  // Per-line eyeline: each speaker looks at the real person that line is spoken to (their reverse target).
  const eyelines = plan.speech
    .map(s => `${s.speaker} → ${s.addressee || plan.listener || "the group"} (eyeline to ${s.addressee || plan.listener || "the addressed partner"}'s established side)`)
    .join("; ");
  return [
    `OPENING ACTOR BLOCKING: ${plan.actionEnglish} Start from the beginning of this scripted action, not its end; preserve the preceding board's action continuity.`,
    `SCENE CAST CONTEXT (not everyone must be visible): ${cast}. All remain in the location unless a scripted exit is shown; off-screen is NOT disappearance.`,
    "AXIS: maintain a coherent 180-degree layout for the whole group; every character keeps the SAME relative screen position and side established by the seating/standing arrangement across every board. When the shot reverses to a different addressee, change only the framing and eyeline to that person's established side — never swap anyone's established side and never teleport a character; nobody turns toward the screen or looks into the lens. Preserve action and location geometry continuity.",
    plan.speech.length ? `DIALOGUE SHOT: ${plan.shot.replace(/_/g, " ")}; focus ${plan.focus}; listener ${plan.listener || "the established partner"}. EYELINES: ${eyelines}. ${reacting.length ? `PRESENT AND REACTING (silent, must not speak another's line): ${reacting.join(", ")}. ` : ""}Cover with a medium / close-up / over-the-shoulder speaker, a reverse-shot to the addressed listener, or a group / two-shot / three-shot when several share the frame. Every named character remains in the scene even when off-screen. Choose ONE framing for this board, no internal shot changes.` : "",
    "Different angles and shot sizes are freely chosen BETWEEN boards by hard cut, never inside the animation. Keep the same master/region-plate geometry authority, walls (never columns instead), and bench back flush against its wall.",
  ].filter(Boolean).join("\n");
}
