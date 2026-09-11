/**
 * Vision check for the character full-body reference (shot `full`, Character.imageFull).
 *
 * The full shot is chained on the face close-up as image_input, and the image model sometimes inherits
 * that tight framing — a medium shot cropped at the hips with an oversized head instead of a head-to-toe
 * figure. This asks gpt-4o whether the generated image is really a full-length figure with normal
 * proportions; the worker regenerates ONCE with a wider framing when it is not. Any error of the check
 * itself is swallowed (returns null) — a reference job never fails because of the check.
 */
import { getOpenAI } from "@/lib/ai";
import type { VisionClient, VisionRequest } from "@/lib/frame-state";

export const FULL_BODY_CHECK_MODEL = "gpt-4o";

export interface FullBodyCheck {
  /** The whole body (head, torso, legs) is in frame — no crop at waist / hips / knees. */
  fullBody: boolean;
  /** Both feet / shoes are fully visible, standing on the floor. */
  feetVisible: boolean;
  /** Realistic human proportions — the head is not oversized relative to the body. */
  proportionsOk: boolean;
}

export const FULL_BODY_CHECK_SYSTEM_PROMPT =
  "You inspect a single photograph of ONE standing person and answer strictly about its framing. " +
  "Return ONLY a JSON object with three boolean fields: " +
  '"fullBody" — true only if the ENTIRE body is inside the frame from the top of the head to the feet (false if the image is cropped at the waist, hips, thighs, knees or ankles); ' +
  '"feetVisible" — true only if both feet / shoes are fully visible and not cut off by the bottom edge; ' +
  '"proportionsOk" — true only if the body has realistic adult human proportions (head roughly 1/7–1/8 of the body height, not an oversized head, not a caricature). ' +
  "No prose, no markdown — JSON only.";

/** Build the vision request (pure; unit-testable). */
export function buildFullBodyCheckRequest(imageUrl: string): VisionRequest {
  return {
    model: FULL_BODY_CHECK_MODEL,
    max_tokens: 100,
    temperature: 0,
    messages: [
      { role: "system", content: FULL_BODY_CHECK_SYSTEM_PROMPT },
      { role: "user", content: [
        { type: "text", text: 'Is this a true head-to-toe full-length shot with realistic proportions? Answer as JSON {"fullBody":boolean,"feetVisible":boolean,"proportionsOk":boolean}.' },
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
    return { fullBody: j.fullBody, feetVisible: j.feetVisible, proportionsOk: j.proportionsOk };
  } catch { return null; }
}

export const fullBodyPasses = (c: FullBodyCheck | null): boolean => !!c && c.fullBody && c.feetVisible && c.proportionsOk;

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
