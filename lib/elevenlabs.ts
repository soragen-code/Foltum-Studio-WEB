/**
 * ElevenLabs Text-to-Speech helper.
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech
 */

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";

/** "Rachel" — calm, clear voice, good default for drama narration/dialogue. */
export const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/** Multilingual v2 supports Russian, Ukrainian, English and 25+ other languages. */
export const DEFAULT_MODEL_ID = "eleven_multilingual_v2";

/** ElevenLabs hard limit for a single request on multilingual_v2 is ~10k chars; stay well below. */
const MAX_TEXT_LENGTH = 5000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface SpeechOptions {
  modelId?: string;
  /** 0..1, default 0.5 */
  stability?: number;
  /** 0..1, default 0.75 */
  similarityBoost?: number;
  /** 0..1, default 0.3 — a bit of expressiveness for drama */
  style?: number;
  /** mp3 output format, default 44.1kHz / 128kbps */
  outputFormat?: string;
  maxRetries?: number;
}

/**
 * Generate speech audio (MP3) from text via ElevenLabs.
 * Returns the raw audio buffer (audio/mpeg).
 * Retries on 429 (rate limit) and 5xx with linear back-off.
 */
export async function generateSpeech(
  text: string,
  voiceId: string = DEFAULT_VOICE_ID,
  options: SpeechOptions = {}
): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");

  const cleaned = (text ?? "").trim();
  if (!cleaned) throw new Error("generateSpeech: text is empty");

  const body = {
    text: cleaned.slice(0, MAX_TEXT_LENGTH),
    model_id: options.modelId ?? DEFAULT_MODEL_ID,
    voice_settings: {
      stability: options.stability ?? 0.5,
      similarity_boost: options.similarityBoost ?? 0.75,
      style: options.style ?? 0.3,
      use_speaker_boost: true,
    },
  };

  const outputFormat = options.outputFormat ?? "mp3_44100_128";
  const url = `${ELEVENLABS_API_URL}/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
  const maxRetries = options.maxRetries ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      return Buffer.from(await res.arrayBuffer());
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      // Honour Retry-After when present, otherwise linear back-off
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 5_000;
      console.log(`ElevenLabs ${res.status}, retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s`);
      await sleep(delay);
      continue;
    }

    const errText = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  throw new Error("ElevenLabs TTS failed after retries");
}
