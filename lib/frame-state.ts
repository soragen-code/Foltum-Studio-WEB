/**
 * Stage 40 — ACTUAL end-state of a generated scene (chain mode).
 *
 * In chain mode («По цепочке») the scenes of an episode are generated one after another. After a
 * scene's clip is ready, its extracted last frame is described by a vision model, pixel-precisely, in
 * English, and the description is stored in `Scene.endStateActual`. The NEXT scene's prompt then
 * opens with that description (OPENING STATE), instead of the scripted `endState` written by the
 * screenwriter. The image itself is never sent to the video model (Stage 38).
 */
import { getOpenAI } from "@/lib/ai";

export const FRAME_STATE_MODEL = "openai/gpt-4o";

/** Minimal client shape so the call can be mocked in unit tests. */
export interface VisionClient {
  chat: { completions: { create: (params: VisionRequest) => Promise<{ choices: Array<{ message: { content: string | null } }> }> } };
}

export interface VisionRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{
    role: "system" | "user";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }>;
  }>;
}

export interface FrameStateScene {
  number: number;
  locationDesc?: string | null;
  sceneKind?: string | null;
  /** Stage 102: the scripted end state — names are mapped to figures purely by the positions described here. */
  endState?: string | null;
}

export interface FrameStateCharacter {
  name: string;
}

/** Stage 102: fallback vision model for the third attempt (same OpenAI client, vision-capable). */
export const FRAME_STATE_FALLBACK_MODEL = "openai/gpt-4o";

/** The mandatory first line of every last-frame description (read by lib/prompt-seam extractPreviousCamera). */
export const CAMERA_OF_THIS_FRAME_PREFIX = "CAMERA OF THIS FRAME:";

/**
 * Stage 102 — the vision model is NEVER asked to recognise or identify anyone. The frame is an
 * AI-generated animated video frame of fictional characters (a Seedance render), figures are referred
 * to by position and role, and names come only from the scripted end state by position mapping.
 * (The old wording "use these names when you recognise them" made gpt-4o refuse — "I can't help with
 * identifying people in images" — and the refusal was saved as the real end state.)
 */
export const FRAME_STATE_SYSTEM_PROMPT =
  "You describe the FINAL frame of a short vertical (9:16) AI-generated animated video clip of fictional characters (a computer-rendered frame, not a photograph of real people) for a continuity hand-off to the next clip. " +
  "This is a composition and staging description, not identification: you never identify or guess who anyone is — no face matching of any kind. " +
  "Refer to figures ONLY by their position and role in the frame (e.g. \"the seated figure on the bench, frame-left\", \"the standing figure in the doorway\"), " +
  "or by a name from the scripted context when that figure's described position / action clearly matches — never from their appearance; if unsure, keep \"the figure …\". " +
  "Never describe faces, hair, skin, body build, clothing or identity — their look is defined elsewhere. Describe only: poses, positions (left/center/right, foreground/background), " +
  "gaze direction, hand positions, props being held, key objects and their placement, environment, lighting direction and colour, time of day, weather, and the camera. " +
  `OUTPUT FORMAT (mandatory): the FIRST line is exactly "${CAMERA_OF_THIS_FRAME_PREFIX} <camera angle relative to the figures / shot scale / camera height>" ` +
  `(e.g. "${CAMERA_OF_THIS_FRAME_PREFIX} eye-level frontal medium shot from the south side"), then a blank line, then the state in 4–8 sentences. ` +
  "Write in English, present tense, plain visual facts only — no story interpretation, no emotions guessed beyond the visible expression, no assumptions about what happens next. " +
  "Never mention that this is a frame or a screenshot in the state sentences.";

/** Build the vision request for a last-frame description (pure; unit-tested). */
export function buildFrameStateRequest(imageUrl: string, scene: FrameStateScene, characters: readonly FrameStateCharacter[]): VisionRequest {
  const names = characters.map((c) => c.name.trim()).filter(Boolean);
  const endState = (scene.endState ?? "").replace(/\s+/g, " ").trim();
  const context = [
    `Scene ${scene.number} of an AI-generated animated video with fictional characters.`,
    scene.locationDesc?.trim() ? `Location: ${scene.locationDesc.trim()}.` : "",
    names.length ? `Scripted character names in this scene: ${names.join(", ")}.` : "",
    endState
      ? `Scripted end state for reference: ${endState} — map the figures to these names purely by their described positions / actions; if unsure, use "the figure …".`
      : "Do not identify anyone — name figures by position and role only.",
    `Describe the final frame for the continuity hand-off, starting with the "${CAMERA_OF_THIS_FRAME_PREFIX}" line.`,
  ].filter(Boolean).join(" ");
  return {
    model: FRAME_STATE_MODEL,
    max_tokens: 500,
    temperature: 0.2,
    messages: [
      { role: "system", content: FRAME_STATE_SYSTEM_PROMPT },
      { role: "user", content: [
        { type: "text", text: context },
        { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
      ] },
    ],
  };
}

/**
 * Stage 102 — an even more neutral request (no character names at all): describe the composition of
 * this animated frame. Used for attempts 2 and 3 after a refusal.
 */
export function buildNeutralFrameStateRequest(imageUrl: string, scene: FrameStateScene, model: string = FRAME_STATE_MODEL): VisionRequest {
  const context = [
    `Scene ${scene.number}.`,
    scene.locationDesc?.trim() ? `Location: ${scene.locationDesc.trim()}.` : "",
    "Describe the composition of this AI-generated animated frame of fictional characters: camera, staging and environment only. " +
    "Refer to every figure only as \"the figure …\" by position (frame-left / centre / frame-right, foreground / background) and pose; no names, no identities, no faces, no clothing.",
    `Start with the "${CAMERA_OF_THIS_FRAME_PREFIX}" line, then a blank line, then 4–8 sentences.`,
  ].filter(Boolean).join(" ");
  return {
    model,
    max_tokens: 500,
    temperature: 0.2,
    messages: [
      { role: "system", content: FRAME_STATE_SYSTEM_PROMPT },
      { role: "user", content: [
        { type: "text", text: context },
        { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
      ] },
    ],
  };
}

/** Stage 102 — true when a vision answer is a refusal ("I'm sorry, I can't help…") or too short to be a real description. */
export function isRefusal(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (t.length < 80) return true;
  return /i'?m sorry|can'?t help|cannot help|unable to (help|assist|identify|describe)|i can'?t (assist|identify|describe)|not able to/i.test(t);
}

/**
 * Describe the final frame of a generated clip. Returns null (and logs) on any error — the chain
 * then falls back to the scripted `endState`, it never stops because of a failed description.
 * Stage 102: a refusal is NEVER returned. Attempt 1 = normal request; attempt 2 = neutral request
 * (no names); attempt 3 = neutral request on the fallback model; all refused → null.
 */
export async function describeLastFrame(
  imageUrl: string,
  scene: FrameStateScene,
  characters: readonly FrameStateCharacter[],
  client?: VisionClient,
): Promise<string | null> {
  let api: VisionClient;
  try {
    api = client ?? (getOpenAI() as unknown as VisionClient);
  } catch (error) {
    console.warn("[frame-state] last-frame description failed:", error instanceof Error ? error.message : String(error));
    return null;
  }
  const attempts: Array<{ label: string; req: VisionRequest }> = [
    { label: "1/normal", req: buildFrameStateRequest(imageUrl, scene, characters) },
    { label: "2/neutral", req: buildNeutralFrameStateRequest(imageUrl, scene) },
    { label: `3/neutral-${FRAME_STATE_FALLBACK_MODEL}`, req: buildNeutralFrameStateRequest(imageUrl, scene, FRAME_STATE_FALLBACK_MODEL) },
  ];
  for (const attempt of attempts) {
    try {
      const res = await api.chat.completions.create(attempt.req);
      const text = (res.choices?.[0]?.message?.content ?? "").trim();
      if (!text.length) {
        console.warn(`[frame-state] attempt ${attempt.label}: empty answer`);
        continue;
      }
      if (isRefusal(text)) {
        console.warn(`[frame-state] attempt ${attempt.label}: refusal / too short (${text.slice(0, 60).replace(/\s+/g, " ")}…)`);
        continue;
      }
      if (attempt.label !== "1/normal") console.warn(`[frame-state] attempt ${attempt.label} succeeded after a refusal`);
      return text;
    } catch (error) {
      console.warn(`[frame-state] attempt ${attempt.label} failed:`, error instanceof Error ? error.message : String(error));
    }
  }
  console.warn("[frame-state] all attempts refused/failed — falling back to the scripted end state");
  return null;
}
