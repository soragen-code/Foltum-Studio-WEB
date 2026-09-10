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

export const FRAME_STATE_MODEL = "gpt-4o";

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
}

export interface FrameStateCharacter {
  name: string;
}

export const FRAME_STATE_SYSTEM_PROMPT =
  "You describe the FINAL frame of a short vertical (9:16) video clip for a continuity hand-off to the next clip. " +
  "Describe exactly what is visible, pixel-precisely: framing and shot size, camera angle, the position of every person " +
  "in the frame (left/center/right, foreground/background), body pose, gaze direction, facial expression, hand positions, " +
  "clothing state, props being held, key objects and their placement, lighting direction and colour, time of day, weather. " +
  "Write in English, 4–8 sentences, present tense, plain visual facts only — no story interpretation, no emotions guessed " +
  "beyond what the face shows, no assumptions about what happens next. Never mention that this is a frame or a screenshot.";

/** Build the vision request for a last-frame description (pure; unit-tested). */
export function buildFrameStateRequest(imageUrl: string, scene: FrameStateScene, characters: readonly FrameStateCharacter[]): VisionRequest {
  const names = characters.map((c) => c.name.trim()).filter(Boolean);
  const context = [
    `Scene ${scene.number}.`,
    scene.locationDesc?.trim() ? `Location: ${scene.locationDesc.trim()}.` : "",
    names.length ? `Characters that may appear (use these names when you recognise them by their position in the shot): ${names.join(", ")}.` : "",
    "Describe the final frame for the continuity hand-off.",
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
 * Describe the final frame of a generated clip. Returns null (and logs) on any error — the chain
 * then falls back to the scripted `endState`, it never stops because of a failed description.
 */
export async function describeLastFrame(
  imageUrl: string,
  scene: FrameStateScene,
  characters: readonly FrameStateCharacter[],
  client?: VisionClient,
): Promise<string | null> {
  try {
    const api = client ?? (getOpenAI() as unknown as VisionClient);
    const res = await api.chat.completions.create(buildFrameStateRequest(imageUrl, scene, characters));
    const text = (res.choices?.[0]?.message?.content ?? "").trim();
    return text.length ? text : null;
  } catch (error) {
    console.warn("[frame-state] last-frame description failed:", error instanceof Error ? error.message : String(error));
    return null;
  }
}
