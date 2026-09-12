/**
 * Vision check for the character full-body reference (shot `full`, Character.imageFull).
 *
 * ONE gpt-4o call per attempt inspects the frame for two things and returns strict JSON:
 *  (a) FRAMING — the whole body is in frame head-to-toe with feet visible, and the figure is not a
 *      big-headed short-legged "dwarf" (~5–5.5 heads tall);
 *  (b) PROPORTIONS (Stage 46D) — measured torsoHeads / legsRatio / headsTall plus the model's own flags
 *      (elongatedTorso, shortLegs, smallHead, inconsistentVolume). The observed failure: a head-to-toe figure
 *      with a ~4-head torso, ~40% legs, an undersized head (8+ heads tall) and a bloated midsection vs thin
 *      limbs — it passed the framing-only guard.
 * `evaluateProportions` turns the measurement into a pure pass/fail verdict with thresholds; the worker
 * regenerates (bounded attempts, shared with the framing retry) with a corrective prompt naming the exact
 * defects, and keeps the best-scoring candidate when every attempt fails. Any error of the check itself is
 * swallowed (returns null) — a reference job never fails because of the check.
 */
import { getOpenAI } from "@/lib/ai";
import type { VisionClient, VisionRequest } from "@/lib/frame-state";

export const FULL_BODY_CHECK_MODEL = "gpt-4o";

/** Minimum heads-tall for an adult figure to pass (real adults are 7–8; below 6.5 reads as chibi/dwarf). */
export const ADULT_MIN_HEADS_TALL = 6.5;
/** Minimum heads-tall for a child character (children are naturally 5–7 heads tall). */
export const CHILD_MIN_HEADS_TALL = 5;

// ---- Stage 46D proportion thresholds (any breach = defect = FAIL) ----
// Stage 52: tightened after a real full-body reference (stretched torso / short-looking legs) still passed
// the older, laxer thresholds — they are now aligned with the ≈ 7–7.5 heads / 3-head torso / half-height legs
// target stated in the prompt, leaving less room for a vertically stretched figure to slip through.
/** Shoulders-to-hip longer than this many head-heights = elongated torso (natural ≈ 3). */
export const MAX_TORSO_HEADS = 3.3;
/** Legs shorter than this fraction of the total height = short legs (natural ≈ 0.45–0.5). */
export const MIN_LEGS_RATIO = 0.44;
/** A figure taller than this many heads has an undersized head (natural adult ≈ 7–7.5). */
export const MAX_HEADS_TALL = 7.9;

export type ProportionDefect = "elongatedTorso" | "shortLegs" | "smallHead" | "inconsistentVolume";
export const PROPORTION_DEFECTS: readonly ProportionDefect[] = ["elongatedTorso", "shortLegs", "smallHead", "inconsistentVolume"];

/** Strict-JSON proportion assessment returned by the vision model (Stage 46D). */
export interface ProportionAssessment {
  /** Total height in head-heights (natural adult ≈ 7–7.5). */
  headsTall: number;
  /** Shoulders-to-hip length in head-heights (natural ≈ 3). */
  torsoHeads: number;
  /** Legs (hip to sole) as a fraction of the total height (natural ≈ 0.45–0.5). */
  legsRatio: number;
  /** The model's own boolean flags. */
  flags: Record<ProportionDefect, boolean>;
  /** Free-text remarks (may be empty). */
  notes: string;
}

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
  /** Stage 46D measured proportions; null = unknown (legacy answer / missing fields) → treated as acceptable. */
  proportions?: ProportionAssessment | null;
}

export const FULL_BODY_CHECK_SYSTEM_PROMPT =
  "You are a strict anatomy and framing inspector for character reference photos. You inspect a single photograph of ONE standing person. " +
  "First MEASURE: estimate the height of the head (top of hair to chin), the total height of the figure (top of hair to soles), the torso length (shoulder line to hip joint / crotch) and the leg length (hip joint to soles). " +
  "Compute headsTall = total / head, torsoHeads = torso / head, legsRatio = legs / total. " +
  "A real adult is about 7–7.5 heads tall, torso about 3 heads, legs about half of the total height, with ONE consistent build (torso, arms and legs of matching volume). " +
  "A figure of 6 heads or less with a big head and short legs is a chibi / dwarf caricature and is WRONG; a figure of 7.9+ heads with a tiny head, a stretched torso of 3.3+ heads or legs under 44% of the height is a vertically STRETCHED figure and is ALSO WRONG. " +
  "ALSO check anatomy: any distorted, deformed or twisted body, or extra / missing / duplicated / fused limbs, hands or fingers, is WRONG. " +
  "And check FRAMING: any part of the figure cut off by an edge (head, hands, hips, legs or feet) is WRONG. " +
  "Return ONLY a JSON object with these fields: " +
  '"fullBody" (boolean) — true only if the ENTIRE body is inside the frame from the top of the head to the feet (false if cropped at the waist, hips, thighs, knees or ankles); ' +
  '"feetVisible" (boolean) — true only if both feet / shoes are fully visible and not cut off by the bottom edge; ' +
  '"headsTall" (number, one decimal) — your measured head-heights estimate; ' +
  '"torsoHeads" (number, one decimal) — torso length in head-heights; ' +
  '"legsRatio" (number, two decimals) — legs / total height; ' +
  '"flags" (object) — {"elongatedTorso": boolean (torso visibly longer than natural, stretched midsection), "shortLegs": boolean (legs clearly under half of the height), "smallHead": boolean (head undersized for the body), "inconsistentVolume": boolean (torso / arms / legs do not match one build — e.g. bloated midsection with thin arms or shins)}; ' +
  '"proportionsOk" (boolean) — true only if the proportions are realistic for the person\'s apparent age, the anatomy is correct (no distortion, no extra / missing / fused limbs or fingers) and none of the flags is set; ' +
  '"issues" (array of short strings) — every concrete problem found, using these labels where they apply: "oversized head", "short legs", "short torso", "elongated torso", "small head", "inconsistent volume", "stocky/compressed body", "cropped body", "feet cut off", "distorted anatomy", "deformed body", "extra limb", "missing limb", "fused limbs", "extra fingers", "child-like proportions"; empty array if none; ' +
  '"notes" (string) — one short sentence of remarks, or empty. ' +
  "Be critical and measure before judging. No prose, no markdown — JSON only.";

/** Build the vision request (pure; unit-testable). */
export function buildFullBodyCheckRequest(imageUrl: string): VisionRequest {
  return {
    model: FULL_BODY_CHECK_MODEL,
    max_tokens: 320,
    temperature: 0,
    messages: [
      { role: "system", content: FULL_BODY_CHECK_SYSTEM_PROMPT },
      { role: "user", content: [
        { type: "text", text: 'Measure this figure. Is it a true head-to-toe full-length shot, uncropped, with natural proportions (no stretched torso, no short legs, no undersized head, one consistent build) and correct anatomy (no distorted, extra, missing or fused limbs)? Answer as JSON {"fullBody":boolean,"feetVisible":boolean,"headsTall":number,"torsoHeads":number,"legsRatio":number,"flags":{"elongatedTorso":boolean,"shortLegs":boolean,"smallHead":boolean,"inconsistentVolume":boolean},"proportionsOk":boolean,"issues":string[],"notes":string}.' },
        { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
      ] },
    ],
  };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Parse the proportion part of an answer (object or raw JSON string). Returns null (= UNKNOWN) when the
 * measurement fields are absent or malformed — unknown never blocks generation.
 */
export function parseProportionAssessment(raw: unknown): ProportionAssessment | null {
  let j: any = raw;
  if (typeof raw === "string") {
    const m = raw.trim().match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { j = JSON.parse(m[0]); } catch { return null; }
  }
  if (!j || typeof j !== "object") return null;
  const headsTall = num(j.headsTall);
  const torsoHeads = num(j.torsoHeads);
  const legsRatio = num(j.legsRatio);
  const hasFlags = j.flags && typeof j.flags === "object";
  // Nothing measurable at all → unknown (legacy answer shape).
  if (!headsTall && !torsoHeads && !legsRatio && !hasFlags) return null;
  const flags = {} as Record<ProportionDefect, boolean>;
  for (const k of PROPORTION_DEFECTS) flags[k] = hasFlags ? j.flags[k] === true : false;
  return { headsTall, torsoHeads, legsRatio, flags, notes: typeof j.notes === "string" ? j.notes.trim() : "" };
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
      proportions: parseProportionAssessment(j),
    };
  } catch { return null; }
}

export interface ProportionVerdict {
  ok: boolean;
  defects: ProportionDefect[];
  /** 0–100, 100 = flawless; lowered by each defect in proportion to its severity. */
  score: number;
}

/**
 * Pure pass/fail on the measured proportions. Thresholds (Stage 52, aligned to the ≈7–7.5 heads / 3-head
 * torso / half-height legs target): torsoHeads > MAX_TORSO_HEADS (3.3) → elongatedTorso;
 * legsRatio < MIN_LEGS_RATIO (0.44) → shortLegs; headsTall > MAX_HEADS_TALL (7.9) → smallHead; plus the
 * model's own flags (any of the four). Any defect → FAIL. `null` (unknown) → ok with an empty defect list
 * (never blocks generation).
 */
export function evaluateProportions(p: ProportionAssessment | null | undefined): ProportionVerdict {
  if (!p) return { ok: true, defects: [], score: 100 };
  const defects: ProportionDefect[] = [];
  let penalty = 0;
  const torsoExcess = p.torsoHeads > MAX_TORSO_HEADS ? p.torsoHeads - MAX_TORSO_HEADS : 0;
  if (torsoExcess > 0 || p.flags.elongatedTorso) { defects.push("elongatedTorso"); penalty += 20 + Math.min(torsoExcess, 1.5) * 20; }
  const legsDeficit = p.legsRatio > 0 && p.legsRatio < MIN_LEGS_RATIO ? MIN_LEGS_RATIO - p.legsRatio : 0;
  if (legsDeficit > 0 || p.flags.shortLegs) { defects.push("shortLegs"); penalty += 20 + Math.min(legsDeficit, 0.1) * 300; }
  const headsExcess = p.headsTall > MAX_HEADS_TALL ? p.headsTall - MAX_HEADS_TALL : 0;
  if (headsExcess > 0 || p.flags.smallHead) { defects.push("smallHead"); penalty += 20 + Math.min(headsExcess, 1.5) * 20; }
  if (p.flags.inconsistentVolume) { defects.push("inconsistentVolume"); penalty += 15; }
  return { ok: defects.length === 0, defects, score: Math.max(0, Math.round(100 - penalty)) };
}

const PROPORTION_FIX_TEXT: Record<ProportionDefect, string> = {
  elongatedTorso: "shorten the torso — shoulders to hip about 3 head-heights, no stretched midsection",
  shortLegs: "lengthen the legs to half of the total body height",
  smallHead: "enlarge the head to natural size — the figure is about 7 to 7.5 heads tall, not more",
  inconsistentVolume: "keep arm, leg and torso thickness consistent with one build — no bloated midsection next to thin limbs",
};

/**
 * Concrete corrections for the found defects, to append to the prompt on a retry. Empty string when
 * there is nothing to fix.
 */
export function buildProportionFixPrompt(defects: readonly ProportionDefect[]): string {
  const uniq = PROPORTION_DEFECTS.filter((d) => defects.includes(d));
  if (!uniq.length) return "";
  return ` PROPORTION FIX (the previous attempt had: ${uniq.join(", ")}): ${uniq.map((d) => PROPORTION_FIX_TEXT[d]).join("; ")}. Camera at chest height, neutral 50mm lens, no vertical stretching.`;
}

const PROPORTION_ISSUE_RE = /oversized head|big head|large head|short legs|stubby|short torso|stocky|compressed|dwarf|chibi/i;
/** Stage 52: distorted / extra-limb findings fail for EVERY character (adult and child alike). */
const DISTORTION_ISSUE_RE = /distort|deform|extra (?:limb|arm|leg|finger|hand)|missing (?:limb|arm|leg|hand)|duplicated|fused|mangled|twisted|melted|warped/i;

/**
 * Pass / fail verdict. `child` selects the child threshold (a child character legitimately has a larger
 * head-to-body ratio). Fails on: cropped body, feet cut off, model verdict proportionsOk=false, measured
 * headsTall below the age threshold (when the model gave a measurement), any oversized-head / short-legs
 * finding in `issues`, any distorted / extra-limb finding (Stage 52), or (Stage 46D) any measured proportion defect.
 */
export function fullBodyPasses(c: FullBodyCheck | null, opts: { child?: boolean } = {}): boolean {
  if (!c || !c.fullBody || !c.feetVisible || !c.proportionsOk) return false;
  const minHeads = opts.child ? CHILD_MIN_HEADS_TALL : ADULT_MIN_HEADS_TALL;
  if (c.headsTall > 0 && c.headsTall < minHeads) return false;
  if (c.issues.some((i) => DISTORTION_ISSUE_RE.test(i))) return false;
  if (!opts.child && c.issues.some((i) => PROPORTION_ISSUE_RE.test(i))) return false;
  if (!evaluateProportions(c.proportions).ok) return false;
  return true;
}

/**
 * Rank attempts when none passes — the worker keeps the best one. Higher is better: full framing first,
 * then the proportion score (fewest / least severe defects), then a realistic heads-tall estimate
 * (capped so a stretched 9-head figure earns nothing extra), then fewest issues.
 */
export function fullBodyScore(c: FullBodyCheck | null): number {
  if (!c) return -1;
  const prop = evaluateProportions(c.proportions);
  return (c.fullBody ? 100 : 0) + (c.feetVisible ? 50 : 0) + (c.proportionsOk ? 25 : 0)
    + Math.min(c.headsTall, 8) * 3 + (prop.score - 100) / 2 - c.issues.length;
}

/**
 * Escalated corrective sentence appended to the prompt on a retry — names the exact problem the
 * previous attempt had so the model fixes THAT (e.g. "previous attempt had oversized head and short legs"),
 * plus the Stage 46D proportion corrections when the measured proportions failed.
 */
export function fullBodyCorrectionSuffix(c: FullBodyCheck | null, attempt: number, opts: { child?: boolean } = {}): string {
  const problems: string[] = [];
  const verdict = evaluateProportions(c?.proportions);
  if (c) {
    if (!c.fullBody) problems.push("the body was cropped");
    if (!c.feetVisible) problems.push("the feet were cut off");
    const hasHead = c.issues.some((i) => /oversized head|big head|large head/.test(i));
    const hasLegs = c.issues.some((i) => /short legs|stubby/.test(i));
    const hasTorso = c.issues.some((i) => /short torso|stocky|compressed/.test(i));
    const hasDistortion = c.issues.some((i) => DISTORTION_ISSUE_RE.test(i));
    if (hasDistortion) problems.push("distorted anatomy (extra, missing, fused or warped limbs)");
    if (hasHead) problems.push("an oversized head");
    if (hasLegs) problems.push("short stubby legs");
    if (hasTorso) problems.push("a short compressed torso");
    if (!hasHead && !hasLegs && !hasTorso && !hasDistortion && verdict.ok && (!c.proportionsOk || (c.headsTall > 0 && c.headsTall < (opts.child ? CHILD_MIN_HEADS_TALL : ADULT_MIN_HEADS_TALL))))
      problems.push(`dwarf-like proportions (only about ${c.headsTall > 0 ? c.headsTall.toFixed(1) : "5"} heads tall)`);
  }
  // A stretched figure (Stage 46D defects) needs the opposite correction from a dwarf one — never ask for
  // "taller and slimmer" when the head is already too small.
  const stretched = verdict.defects.includes("smallHead") || verdict.defects.includes("elongatedTorso");
  const found = problems.length ? problems.join(", ") : verdict.defects.length ? "wrong body proportions" : "wrong body proportions and framing";
  const target = opts.child
    ? "make the figure a naturally proportioned child about 6–7 heads tall, feet on the floor, whole body in frame"
    : stretched
      ? "render a naturally proportioned adult about 7 to 7.5 heads tall: a natural-size head, a torso of about 3 head-heights, legs about half of the total height, one consistent build, whole body head-to-toe in frame with both feet on the floor"
      : "make the figure TALLER and slimmer: about 7.5 heads tall (never 8 or more), a natural-size head, LONG legs (half of the total height), a natural torso of about 3 head-heights, whole body head-to-toe in frame with both feet on the floor";
  const escalation = attempt >= 3
    ? " Step the camera further back and render the person as a long-legged adult of real-life proportions — a clear correction of the earlier mistake, not a repeat of it."
    : "";
  return ` CORRECTION (attempt ${attempt}): the previous attempt was WRONG — it had ${found}. Fix it: ${target}.${escalation}${buildProportionFixPrompt(verdict.defects)}`;
}

/**
 * Run the check on an image URL. Returns null on ANY error (network, parsing, missing key) so the
 * caller simply keeps the generated image.
 */
export async function checkFullBodyImage(imageUrl: string, client?: VisionClient): Promise<FullBodyCheck | null> {
  try {
    const api = client ?? (getOpenAI() as unknown as VisionClient);
    const res = await api.chat.completions.create(buildFullBodyCheckRequest(imageUrl));
    const parsed = parseFullBodyCheck(res.choices?.[0]?.message?.content);
    if (!parsed) console.warn("[images-job] full-body check returned malformed JSON (treated as unknown, frame accepted)");
    return parsed;
  } catch (error) {
    console.warn("[images-job] full-body check errored (skipped):", error instanceof Error ? error.message : String(error));
    return null;
  }
}
