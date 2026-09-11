/**
 * Stage 46B — thematic background music for an assembled episode.
 *
 *   1. `pickMood()` — gpt-4o (chatJSON) reads the episode logline / project synopsis and picks ONE
 *      mood from the fixed `MOODS` list (validated with zod; falls back to "mysterious").
 *   2. `getOrCreateMusicTrack()` — an instrumental loop is generated once per project+mood with
 *      Meta MusicGen on Replicate (30 s, the longest the model allows) and cached in S3 under
 *      `music/<projectId>/<mood>.mp3`; every later assembly with the same mood reuses the file.
 *      The track is LOOPED by ffmpeg to the episode length (see buildMusicMixFilter).
 *   Any failure → the caller assembles WITHOUT music (never fails the episode).
 */
import { z } from "zod";
import { chatJSON } from "@/lib/ai";
import { getReplicate, getPredictionState } from "@/lib/replicate";
import { getBucketConfig } from "@/lib/aws-config";
import { uploadBufferToS3 } from "@/lib/s3-upload";

export const MOODS = ["tense", "romantic", "melancholic", "uplifting", "dark", "mysterious", "action"] as const;
export type Mood = (typeof MOODS)[number];
export const DEFAULT_MOOD: Mood = "mysterious";

export const moodSchema = z.object({ mood: z.enum(MOODS) });

/** Russian label for the job message («Подбор музыки: напряжённая»). */
export const MOOD_LABELS: Record<Mood, string> = {
  tense: "напряжённая",
  romantic: "романтичная",
  melancholic: "меланхоличная",
  uplifting: "воодушевляющая",
  dark: "мрачная",
  mysterious: "загадочная",
  action: "экшн",
};

/** Instrumental prompt per mood for MusicGen (short, no vocals, loop-friendly). */
export const MOOD_PROMPTS: Record<Mood, string> = {
  tense: "tense suspenseful cinematic underscore, pulsing low strings, ticking percussion, no vocals, seamless loop",
  romantic: "warm romantic cinematic piano and soft strings, gentle and intimate, no vocals, seamless loop",
  melancholic: "melancholic slow cinematic piano with soft pads, wistful and sad, no vocals, seamless loop",
  uplifting: "uplifting hopeful cinematic score, bright strings and light percussion, no vocals, seamless loop",
  dark: "dark brooding cinematic drone, deep bass, ominous textures, no vocals, seamless loop",
  mysterious: "mysterious atmospheric cinematic underscore, soft synth pads, subtle bells, no vocals, seamless loop",
  action: "driving action cinematic score, fast percussion, powerful brass and strings, no vocals, seamless loop",
};

export const MUSIC_MODEL = "meta/musicgen";
/** MusicGen renders at most 30 s; the file is looped to the episode length. */
export const MUSIC_TRACK_SECONDS = 30;
const MUSIC_TIMEOUT_MS = 4 * 60 * 1000;
const POLL_MS = 4000;

/** Validate a raw model answer; unknown / malformed → DEFAULT_MOOD. */
export function parseMood(raw: unknown): Mood {
  const r = moodSchema.safeParse(raw);
  return r.success ? r.data.mood : DEFAULT_MOOD;
}

/** Pick the episode mood with gpt-4o from the synopsis / logline / genre hints. */
export async function pickMood(input: { logline?: string | null; synopsis?: string | null; title?: string | null }): Promise<Mood> {
  const text = [input.title, input.logline, input.synopsis].filter(Boolean).join("\n\n").slice(0, 4000);
  if (!text.trim()) return DEFAULT_MOOD;
  try {
    const raw = await chatJSON<unknown>(
      `You pick the background music mood for a short vertical drama episode. Answer ONLY with JSON {"mood": <one of ${MOODS.join(", ")}>}.`,
      text,
      { model: "gpt-4o", temperature: 0.2, maxTokens: 30 }
    );
    return parseMood(raw);
  } catch (err) {
    console.warn("[music] mood pick failed — using default:", (err as Error).message);
    return DEFAULT_MOOD;
  }
}

/** S3 object key of the cached track for a project + mood. */
export function musicCacheKey(projectId: string, mood: Mood): string {
  const { folderPrefix } = getBucketConfig();
  return `${folderPrefix}public/music/${projectId}/${mood}.mp3`;
}

function publicUrlForKey(key: string): string {
  const { bucketName } = getBucketConfig();
  const region = process.env.AWS_REGION ?? "us-east-1";
  return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
}

/** Generate a 30 s instrumental with MusicGen; returns the temporary Replicate output URL. */
export async function generateMusicTrack(mood: Mood): Promise<string> {
  const prediction = await getReplicate().predictions.create({
    model: MUSIC_MODEL as `${string}/${string}`,
    input: {
      prompt: MOOD_PROMPTS[mood],
      duration: MUSIC_TRACK_SECONDS,
      model_version: "stereo-large",
      output_format: "mp3",
      normalization_strategy: "peak",
    },
  });
  const started = Date.now();
  for (;;) {
    const state = await getPredictionState(prediction.id);
    if (state.status === "succeeded" && state.url) return state.url;
    if (state.status === "succeeded") throw new Error("MusicGen returned no output");
    if (state.status === "failed" || state.status === "canceled") throw new Error(state.error || "MusicGen failed");
    if (Date.now() - started > MUSIC_TIMEOUT_MS) throw new Error("MusicGen timed out");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Return the public S3 URL of the project's track for `mood`, generating + caching it on the
 * first request. Throws when the track cannot be produced (caller assembles without music).
 */
export async function getOrCreateMusicTrack(projectId: string, mood: Mood): Promise<string> {
  const key = musicCacheKey(projectId, mood);
  const cachedUrl = publicUrlForKey(key);
  try {
    const head = await fetch(cachedUrl, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
    if (head.ok) return cachedUrl;
  } catch {
    /* not cached (or HEAD blocked) — generate */
  }
  const tmpUrl = await generateMusicTrack(mood);
  const res = await fetch(tmpUrl);
  if (!res.ok) throw new Error(`Music download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1000) throw new Error("Music file is empty");
  return uploadBufferToS3(buffer, key, "audio/mpeg");
}
