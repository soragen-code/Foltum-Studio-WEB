/** Stage 132 — validated shot/speech/camera data, confined to Storyboard. */
import { z } from "zod";
import { normalizeBoards, validateBoards, type RawBoard } from "@/lib/storyboard";
import { estimatedSpeechSeconds, hasActorTravel, type SpeechSegment } from "@/lib/storyboard-dialogue";

const speechSchema = z.object({ id: z.string(), sourceId: z.string(), speaker: z.string(), text: z.string(), delivery: z.string(), estimatedSec: z.number() });
const directionSchema = z.object({
  version: z.literal(132),
  cameraMode: z.enum(["LOCKED_OFF", "TRACKING"]),
  travelEvidence: z.string(),
  actionEnglish: z.string(),
  shot: z.enum(["action", "medium", "close_up", "over_shoulder", "listener_reverse"]),
  focus: z.string(), listener: z.string(),
  cast: z.array(z.string()),
  speech: z.array(speechSchema),
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

/** Preserve the ledger exactly: model references immutable IDs, never rewrites spoken text. */
export function finalizeDirectedBoards(raw: RawDirectedBoard[], segments: SpeechSegment[], cast: string[], actionSource: string) {
  if (!Array.isArray(raw) || raw.length < 12 || raw.length > 15)
    throw new Error("Storyboard planning conflict: exactly 12–15 boards required. No boards or dialogue were truncated.");
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
    if (hasActorTravel(action) && !hasActorTravel(evidence))
      throw new Error(`Board ${index + 1}: travelling action needs literal source movement evidence.`);
    if (hasActorTravel(evidence) && !hasActorTravel(action))
      throw new Error(`Board ${index + 1}: stationary reaction cannot inherit a tracking instruction from another beat.`);
    if (/["«“]/u.test(action)) throw new Error(`Board ${index + 1}: put speech in source IDs, not actionEnglish.`);
    const firstSpeaker = speech[0]?.speaker ?? "";
    if (speech.some(s => !cast.includes(s.speaker))) throw new Error("Source speaker does not match the episode cast.");
    const listener = b.listener || speech.find(s => s.speaker !== firstSpeaker)?.speaker || cast.find(c => c !== firstSpeaker) || "";
    if (listener && (!cast.includes(listener) || listener === firstSpeaker)) throw new Error("Invalid dialogue listener mapping.");
    const shot = speech.length ? (b.shot && b.shot !== "action" ? b.shot : "over_shoulder") : "action";
    return directionSchema.parse({
      version: 132, cameraMode: hasActorTravel(evidence) ? "TRACKING" : "LOCKED_OFF",
      travelEvidence: evidence, actionEnglish: action, shot,
      focus: shot === "listener_reverse" ? listener : firstSpeaker,
      listener, cast: [...cast], speech,
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
  const cast = plan.cast.map((name, i) => `${name}: staging position ${i + 1}${i === 0 ? ", screen-left looking right" : i === 1 ? ", screen-right looking left" : ", retain established background position"}`).join("; ");
  return [
    `OPENING ACTOR BLOCKING: ${plan.actionEnglish} Start from the beginning of this scripted action, not its end; preserve the preceding board's action continuity.`,
    `SCENE CAST CONTEXT (not everyone must be visible): ${cast}. All remain in the location unless a scripted exit is shown; off-screen is NOT disappearance.`,
    "AXIS: maintain the same side of the 180-degree dialogue axis, stable screen sides, connected partner eyelines; nobody turns toward the screen or looks into the lens. Preserve action and location geometry continuity.",
    plan.speech.length ? `DIALOGUE SHOT: ${plan.shot.replace(/_/g, " ")}; focus ${plan.focus}; listener ${plan.listener || "the established partner"}. Medium / close-up / over-the-shoulder speaker or reverse-shot listener coverage. The speaking character remains in scene even when off-screen. Choose ONE framing for this board, no internal shot changes.` : "",
    "Different angles and shot sizes are freely chosen BETWEEN boards by hard cut, never inside the animation. Keep the same master/region-plate geometry authority, walls (never columns instead), and bench back flush against its wall.",
  ].filter(Boolean).join("\n");
}
