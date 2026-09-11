/**
 * Vision check for the character full-body reference (shot `full`, Character.imageFull).
 *
 * The full shot is chained on the face close-up as image_input, and the image model tends to inherit
 * that reference's head scale: either a medium shot cropped at the hips, or — the "dwarf" bug — a
 * head-to-toe figure squeezed into the 9:16 frame with an oversized head, short torso and stubby legs
 * (~5–5.5 heads tall instead of an adult's 7.5–8). This asks gpt-4o to (a) confirm the framing is really
 * head-to-toe and (b) ESTIMATE how many head-heights tall the figure is, plus a list of concrete
 * proportion issues. The worker regenerates (up to 2 retries) with a corrective prompt naming the exact
 * problem when the check fails. Any error of the check itself is swallowed (returns null) — a reference
 * job never fails because of the check.
 */
import { getOpenAI } from "@/lib/ai";
import type { VisionClient, VisionRequest } from "@/lib/frame-state";

export const FULL_BODY_CHECK_MODEL = "gpt-4o";

/** Minimum heads-tall for an adult figure to pass (real adults are 7–8; below 6.5 reads as chibi/dwarf). */
export const ADULT_MIN_HEADS_TALL = 6.5;
/** Minimum heads-tall for a child character (children are naturally 5–7 heads tall). */
export const CHILD_MIN_HEADS_TALL = 5;

export interface FullBodyCheck {
  /** The whole body (head, torso, legs) is in frame — no crop at waist / hips / knees. */
  fullBody: boolean;
  /** Both feet / shoes are fully visible, standing on the floor. */
  feetVisible: boolean;
  /** Model's own verdict: realistic human proportions (no oversized head, no short stubby legs). */
  proportionsOk: boolean;
  /** Estimated figure height in head-heights (adult ≈ 7.5–8, chibi/dwarf ≈ 4–5.5). */
  headsTall: number;
  /** Concrete proportion / framing problems found (empty when fine), e.g. "oversized head", "short legs". */
  issues: string[];
}

export const FULL_BODY_CHECK_SYSTEM_PROMPT =
  "You are a strict anatomy and framing inspector for character reference photos. You inspect a single photograph of ONE standing person. " +
  "First MEASURE: estimate the height of the head (top of hair to chin) and the total height of the figure (top of hair to soles) and compute headsTall = total / head. " +
  "A real adult is 7–8 heads tall with legs about half of the total height; a figure of 6 heads or less with a big head and short legs is a chibi / dwarf-like caricature and is WRONG for an adult. " +
  "Return ONLY a JSON object with these fields: " +
  '"fullBody" (boolean) — true only if the ENTIRE body is inside the frame from the top of the head to the feet (false if cropped at the waist, hips, thighs, knees or ankles); ' +
  '"feetVisible" (boolean) — true only if both feet / shoes are fully visible and not cut off by the bottom edge; ' +
  '"headsTall" (number, one decimal) — your measured head-heights estimate; ' +
  '"proportionsOk" (boolean) — true only if the proportions are realistic for the person\'s apparent age: for an adult headsTall >= 7 with a small head, long legs (about half of the height) and a normal torso; no oversized head, no short stubby legs, not stocky/compressed, not a caricature; ' +
  '"issues" (array of short strings) — every concrete problem found, using these labels where they apply: "oversized head", "short legs", "short torso", "stocky/compressed body", "cropped body", "feet cut off", "child-like proportions"; empty array if none. ' +
  "Be critical: when in doubt about an adult with a large head and short legs, report the issue. No prose, no markdown — JSON only.";

/** Build the vision request (pure; unit-testable). */
export function buildFullBodyCheckRequest(imageUrl: string): VisionRequest {
  return {
    model: FULL_BODY_CHECK_MODEL,
    max_tokens: 200,
    temperature: 0,
    messages: [
      { role: "system", content: FULL_BODY_CHECK_SYSTEM_PROMPT },
      { role: "user", content: [
        { type: "text", text: 'Measure this figure. Is it a true head-to-toe full-length shot with realistic proportions for the person\'s age? Answer as JSON {"fullBody":boolean,"feetVisible":boolean,"headsTall":number,"proportionsOk":boolean,"issues":string[]}.' },
        { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
      ] },
    ],
  };
}

/** Parse the model answer; null when it is not the expected JSON. */
export function parseFullBodyCheck(raw: string | null | undefined): FullBodyCheck | null {
  if (!raw) return null;
  const m = raw.trim().match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j?.fullBody !== "boolean" || typeof j?.feetVisible !== "boolean" || typeof j?.proportionsOk !== "boolean") return null;
    const heads = Number(j.headsTall);
    const issues = Array.isArray(j.issues) ? j.issues.filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0).map((x: string) => x.trim().toLowerCase()) : [];
    return {
      fullBody: j.fullBody,
      feetVisible: j.feetVisible,
      proportionsOk: j.proportionsOk,
      headsTall: Number.isFinite(heads) && heads > 0 ? heads : 0,
      issues,
    };
  } catch { return null; }
}

const PROPORTION_ISSUE_RE = /oversized head|big head|large head|short legs|stubby|short torso|stocky|compressed|dwarf|chibi/i;

/**
 * Pass / fail verdict. `child` selects the child threshold (a child character legitimately has a larger
 * head-to-body ratio). Fails on: cropped body, feet cut off, model verdict proportionsOk=false, measured
 * headsTall below the age threshold (when the model gave a measurement), or any oversized-head / short-legs
 * finding in `issues`.
 */
export function fullBodyPasses(c: FullBodyCheck | null, opts: { child?: boolean } = {}): boolean {
  if (!c || !c.fullBody || !c.feetVisible || !c.proportionsOk) return false;
  const minHeads = opts.child ? CHILD_MIN_HEADS_TALL : ADULT_MIN_HEADS_TALL;
  if (c.headsTall > 0 && c.headsTall < minHeads) return false;
  if (!opts.child && c.issues.some((i) => PROPORTION_ISSUE_RE.test(i))) return false;
  return true;
}

/**
 * Rank attempts when none passes — the worker keeps the best one. Higher is better: full framing first,
 * then the tallest (most realistic) heads-tall estimate, then fewest issues.
 */
export function fullBodyScore(c: FullBodyCheck | null): number {
  if (!c) return -1;
  return (c.fullBody ? 100 : 0) + (c.feetVisible ? 50 : 0) + (c.proportionsOk ? 25 : 0) + Math.min(c.headsTall, 9) * 3 - c.issues.length;
}

/**
 * Escalated corrective sentence appended to the prompt on a retry — names the exact problem the
 * previous attempt had so the model fixes THAT (e.g. "previous attempt had oversized head and short legs").
 */
export function fullBodyCorrectionSuffix(c: FullBodyCheck | null, attempt: number, opts: { child?: boolean } = {}): string {
  const problems: string[] = [];
  if (c) {
    if (!c.fullBody) problems.push("the body was cropped");
    if (!c.feetVisible) problems.push("the feet were cut off");
    const hasHead = c.issues.some((i) => /oversized head|big head|large head/.test(i));
    const hasLegs = c.issues.some((i) => /short legs|stubby/.test(i));
    const hasTorso = c.issues.some((i) => /short torso|stocky|compressed/.test(i));
    if (hasHead) problems.push("an oversized head");
    if (hasLegs) problems.push("short stubby legs");
    if (hasTorso) problems.push("a short compressed torso");
    if (!hasHead && !hasLegs && !hasTorso && (!c.proportionsOk || (c.headsTall > 0 && c.headsTall < (opts.child ? CHILD_MIN_HEADS_TALL : ADULT_MIN_HEADS_TALL))))
      problems.push(`dwarf-like proportions (only about ${c.headsTall > 0 ? c.headsTall.toFixed(1) : "5"} heads tall)`);
  }
  const found = problems.length ? problems.join(", ") : "wrong body proportions and framing";
  const target = opts.child
    ? "make the figure a naturally proportioned child about 6–7 heads tall, feet on the floor, whole body in frame"
    : "make the figure TALLER and slimmer: 8 heads tall, a SMALL head (1/8 of the height), LONG legs (half of the total height), a long natural torso, whole body head-to-toe in frame with both feet on the floor";
  const escalation = attempt >= 3
    ? " Step the camera further back and render the person as a tall, long-legged adult of real-life proportions — a clear correction of the earlier mistake, not a repeat of it."
    : "";
  return ` CORRECTION (attempt ${attempt}): the previous attempt was WRONG — it had ${found}. Fix it: ${target}.${escalation}`;
}

/**
 * Run the check on an image URL. Returns null on ANY error (network, parsing, missing key) so the
 * caller simply keeps the generated image.
 */
export async function checkFullBodyImage(imageUrl: string, client?: VisionClient): Promise<FullBodyCheck | null> {
  try {
    const api = client ?? (getOpenAI() as unknown as VisionClient);
    const res = await api.chat.completions.create(buildFullBodyCheckRequest(imageUrl));
    return parseFullBodyCheck(res.choices?.[0]?.message?.content);
  } catch (error) {
    console.warn("[images-job] full-body check errored (skipped):", error instanceof Error ? error.message : String(error));
    return null;
  }
}
