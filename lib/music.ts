/**
 * Stage 46B — thematic background music for an assembled episode.
 *
 *   1. `pickMood()` — gpt-4o (chatJSON) reads the episode logline / project synopsis and picks ONE
 *      mood from the fixed `MOODS` list (validated with zod; falls back to "mysterious").
 *   2. `getOrCreateMusicTrack()` — an instrumental track is generated once per project+mood with
 *      ACE-Step 1.5 on WaveSpeed (Stage 104) and cached in S3 under `music/<projectId>/<mood>.mp3`;
 *      every later assembly with the same mood reuses the file. The track is LOOPED by ffmpeg to
 *      the episode length (see buildMusicMixFilter).
 *   Any failure → the caller assembles WITHOUT music (never fails the episode).
 */
import { z } from "zod";
import { chatJSON } from "@/lib/ai";
import { wavespeedSubmit, wavespeedWait } from "@/lib/wavespeed";
import { getBucketConfig } from "@/lib/aws-config";
import { uploadBufferToS3 } from "@/lib/s3-upload";

export const MOODS = ["tense", "romantic", "melancholic", "uplifting", "dark", "mysterious", "action"] as const;
export type Mood = (typeof MOODS)[number];
export const DEFAULT_MOOD: Mood = "mysterious";

export const moodSchema = z.object({ mood: z.enum(MOODS) });

/** Russian label for the job message ("Music selection: tense"). */
export const MOOD_LABELS: Record<Mood, string> = {
  tense: "tense",
  romantic: "romantic",
  melancholic: "melancholic",
  uplifting: "uplifting",
  dark: "dark",
  mysterious: "mysterious",
  action: "action",
};

/** Instrumental style description per mood (short, no vocals, loop-friendly) — becomes the ACE-Step tags. */
export const MOOD_PROMPTS: Record<Mood, string> = {
  tense: "tense suspenseful cinematic underscore, pulsing low strings, ticking percussion, no vocals, seamless loop",
  romantic: "warm romantic cinematic piano and soft strings, gentle and intimate, no vocals, seamless loop",
  melancholic: "melancholic slow cinematic piano with soft pads, wistful and sad, no vocals, seamless loop",
  uplifting: "uplifting hopeful cinematic score, bright strings and light percussion, no vocals, seamless loop",
  dark: "dark brooding cinematic drone, deep bass, ominous textures, no vocals, seamless loop",
  mysterious: "mysterious atmospheric cinematic underscore, soft synth pads, subtle bells, no vocals, seamless loop",
  action: "driving action cinematic score, fast percussion, powerful brass and strings, no vocals, seamless loop",
};

/** WaveSpeed ACE-Step 1.5 model slug (instrumental background score). */
export const MUSIC_MODEL = "wavespeed-ai/ace-step-1.5";
/** Track length requested from ACE-Step (s); the file is looped to the episode length. */
export const MUSIC_TRACK_SECONDS = 60;
export const ACE_STEP_MIN_DURATION = 5;
export const ACE_STEP_MAX_DURATION = 240;
/** Appended to every mood's tags so the track is always an instrumental underscore. */
export const MUSIC_INSTRUMENTAL_TAGS = "instrumental, cinematic, background score, no vocals";
const MUSIC_TIMEOUT_MS = 4 * 60 * 1000;
const POLL_MS = 4000;

/** Pure: ACE-Step style tags for a mood (MOOD_PROMPTS + the instrumental suffix). */
export function moodToTags(mood: Mood): string {
  return `${MOOD_PROMPTS[mood] ?? MOOD_PROMPTS[DEFAULT_MOOD]}, ${MUSIC_INSTRUMENTAL_TAGS}`;
}

/** Pure request body builder for POST /wavespeed-ai/ace-step-1.5 (exported for tests). */
export function buildAceStepBody(mood: Mood, durationSec: number = MUSIC_TRACK_SECONDS): { tags: string; lyrics: string; duration: number } {
  const raw = Number.isFinite(durationSec) ? Math.round(durationSec) : MUSIC_TRACK_SECONDS;
  const duration = Math.max(ACE_STEP_MIN_DURATION, Math.min(ACE_STEP_MAX_DURATION, raw));
  return { tags: moodToTags(mood), lyrics: "[instrumental]", duration };
}

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

/** Generate an instrumental track with ACE-Step 1.5 on WaveSpeed; returns the temporary output URL. */
export async function generateMusicTrack(mood: Mood): Promise<string> {
  const id = await wavespeedSubmit(MUSIC_MODEL, buildAceStepBody(mood), "WaveSpeed music");
  return wavespeedWait(id, { timeoutMs: MUSIC_TIMEOUT_MS, pollMs: POLL_MS, label: "WaveSpeed music" });
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
