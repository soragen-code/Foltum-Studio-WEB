/**
 * Scene voiceover: turns a scripted dialogue block into natural human speech.
 *
 * - Strips speaker labels ("YARA:"), stage directions "(whispering)" and
 *   "[NO DIALOGUE]" markers so they are never read aloud.
 * - Each character gets a consistent, human, actor-grade ElevenLabs voice
 *   picked by inferred gender (deterministic per character name).
 * - Multi-speaker scenes are rendered line by line and concatenated.
 */

import { generateSpeech } from "@/lib/elevenlabs";

export interface DialogueLine {
  speaker: string | null;
  text: string;
}

export interface VoiceCharacter {
  name: string;
  description?: string | null;
  role?: string | null;
  personality?: string | null;
  appearance?: string | null;
}

/** Default pools = ElevenLabs premade human voices (actor / storyteller quality). Override via env. */
const DEFAULT_FEMALE_VOICES = [
  "pFZP5JQG7iQjIQuC4Bku", // Lily — velvety actress
  "EXAVITQu4vr4xnSDxMaL", // Sarah — mature, confident
  "cgSgspJ2msm6clMCkdW9", // Jessica — warm
];
const DEFAULT_MALE_VOICES = [
  "JBFqnCBsd6RMkjVDRZzb", // George — warm storyteller
  "cjVigY5qzO86Huf0OWal", // Eric — smooth
  "nPczCjzI2devNBz1zQrb", // Brian — deep, resonant
  "pNInz6obpgDQGcFmaJgB", // Adam — firm
];

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

const FEMALE_RE = /\b(she|her|hers|herself|woman|women|female|girl|lady|mother|mom|sister|daughter|wife|girlfriend|actress|queen|princess|heroine|mrs|ms|miss)\b/gi;
const MALE_RE = /\b(he|him|his|himself|man|men|male|boy|guy|gentleman|father|dad|brother|son|husband|boyfriend|actor|king|prince|hero|mr)\b/gi;

export type Gender = "female" | "male";

/** Infer gender from free-text character fields (name is ignored — too unreliable across languages). */
export function inferGender(c: VoiceCharacter): Gender {
  const text = [c.description, c.role, c.personality, c.appearance].filter(Boolean).join(" ");
  const f = (text.match(FEMALE_RE) ?? []).length;
  const m = (text.match(MALE_RE) ?? []).length;
  return f >= m ? "female" : "male";
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic voice for a character: same character → same voice in every scene. */
export function pickVoiceId(c: VoiceCharacter): string {
  const gender = inferGender(c);
  const pool = envList(
    gender === "female" ? "ELEVENLABS_FEMALE_VOICES" : "ELEVENLABS_MALE_VOICES",
    gender === "female" ? DEFAULT_FEMALE_VOICES : DEFAULT_MALE_VOICES
  );
  return pool[hashString(c.name.trim().toLowerCase()) % pool.length];
}

const NO_DIALOGUE_RE = /^\s*\[?\s*(no\s+dialogue|без\s+диалога|без\s+діалогу|silence|тишина)\s*\]?\s*\.?\s*$/i;
/** "YARA:" / "YARA (whispering):" / "Yara (V.O.):" — label is 1-4 words, optional parenthetical, then a colon/dash. */
const SPEAKER_RE = /^\s*([A-ZА-ЯЁІЇЄҐ][\w'’.\-]*(?:\s+[A-ZА-ЯЁІЇЄҐ][\w'’.\-]*){0,3})\s*(\([^)]*\))?\s*[:—–-]\s*/u;
const DIRECTION_RE = /\([^)]*\)|\[[^\]]*\]|\*[^*]*\*/g;
const QUOTES_RE = /^["'“”«»„‘’]+|["'“”«»„‘’]+$/g;

/** Split a scripted dialogue block into speakable lines (labels & directions removed). */
export function parseDialogue(raw: string | null | undefined): DialogueLine[] {
  const block = (raw ?? "").trim();
  if (!block || NO_DIALOGUE_RE.test(block)) return [];

  const lines: DialogueLine[] = [];
  let currentSpeaker: string | null = null;

  for (const rawLine of block.split(/\r?\n+/)) {
    let line = rawLine.trim();
    if (!line || NO_DIALOGUE_RE.test(line)) continue;

    const m = line.match(SPEAKER_RE);
    if (m) {
      currentSpeaker = m[1].trim();
      line = line.slice(m[0].length);
    }

    const text = line.replace(DIRECTION_RE, " ").replace(/\s+/g, " ").trim().replace(QUOTES_RE, "").trim();
    if (!text) continue;

    // Merge consecutive lines of the same speaker into one utterance
    const last = lines[lines.length - 1];
    if (last && last.speaker === currentSpeaker) last.text += " " + text;
    else lines.push({ speaker: currentSpeaker, text });
  }
  return lines;
}

/**
 * Build a Seedance prompt that makes the characters SPEAK their lines on-screen,
 * with lip movement and diegetic ambient sound — so the audio is native to the clip
 * (coming from the actors' mouths, blended with the environment) rather than a track
 * laid on top. Background music is explicitly suppressed to avoid copyright issues.
 *
 * The scripted dialogue is cleaned of speaker labels and stage directions; each line
 * is re-attached to its speaker by name so the model knows who says what.
 */
/**
 * Detect the spoken language of a dialogue block so the video model pronounces it
 * natively instead of applying the wrong (usually English) phonetics — the main
 * cause of "the words are broken / mispronounced" with native audio.
 */
export function detectSpokenLanguage(text: string | null | undefined): string {
  const t = text ?? "";
  const hasCyrillic = /[\u0400-\u04FF]/.test(t);
  if (hasCyrillic) {
    // Ukrainian-specific letters distinguish it from Russian.
    if (/[іїєґІЇЄҐ]/.test(t)) return "Ukrainian";
    return "Russian";
  }
  if (/[\u4E00-\u9FFF]/.test(t)) return "Chinese";
  if (/[\u3040-\u30FF]/.test(t)) return "Japanese";
  if (/[\uAC00-\uD7AF]/.test(t)) return "Korean";
  if (/[áéíóúñ¿¡]/i.test(t)) return "Spanish";
  return "English";
}

/** Map the UI's two-letter language code to a full language name for the prompt. */
export function languageName(code: string | null | undefined): string {
  switch ((code ?? "").toLowerCase()) {
    case "ru":
      return "Russian";
    case "en":
      return "English";
    default:
      return "";
  }
}

/**
 * Translate a scripted dialogue block into `targetLanguage`, preserving the
 * "Speaker: line" structure and stage directions in [brackets]. Only the spoken
 * words are translated. Returns the original block unchanged on any failure.
 */
export async function translateDialogue(
  dialogue: string | null | undefined,
  targetLanguage: string
): Promise<string> {
  const block = (dialogue ?? "").trim();
  if (!block || !targetLanguage) return block;
  try {
    // Lazy import so the pure prompt builders stay dependency-free / testable.
    const { chat } = await import("@/lib/ai");
    const out = await chat(
      `You are a professional screenplay translator. Translate ALL spoken dialogue into ${targetLanguage}. ` +
        `Keep the exact same line structure: preserve "Speaker:" name prefixes (do NOT translate character names) ` +
        `and keep any [stage directions] in brackets. Translate ONLY the spoken words, naturally and idiomatically ` +
        `for ${targetLanguage}. Return ONLY the translated dialogue block, nothing else.`,
      block,
      { temperature: 0.3, maxTokens: 2048 }
    );
    return (out ?? "").trim() || block;
  } catch {
    return block;
  }
}

export function buildNativeAudioPrompt(
  basePrompt: string,
  dialogue: string | null | undefined,
  characters: VoiceCharacter[],
  explicitLanguage?: string
): string {
  const base = (basePrompt ?? "").trim();
  const lines = parseDialogue(dialogue);

  // Seedance 2.5 bracket semantics: {text} = spoken line, (text) = music cue.
  // Round brackets are intentionally ABSENT so the model never generates a musical score.
  const AUDIO_DIRECTION =
    "AUDIO TRACK: dialogue and ambient sound only. " +
    "NO background music. NO score. NO instrumental track. NO soundtrack. NO musical theme. " +
    "Only the characters' voices (lip-synced on camera) and the natural ambient sound of the location. " +
    "No narration voiceover. No on-screen text or subtitles.";

  if (!lines.length) {
    // No dialogue — ambient sound only. NO round brackets (= music cue in Seedance 2.5).
    return `${base}\n\nAUDIO TRACK: ambient sound and room tone of the location only. NO background music. NO score. NO soundtrack. No voiceover. No subtitles.`;
  }

  // Explicit selection (from the per-scene EN/RU picker) wins; else auto-detect.
  const language =
    (explicitLanguage && explicitLanguage.trim()) ||
    detectSpokenLanguage(lines.map((l) => l.text).join(" "));

  const spoken = lines
    .map((l) => {
      const character = findCharacter(l.speaker, characters);
      const who = character?.name ?? l.speaker ?? "Character";
      // Seedance 2.5 markup: {text} = spoken dialogue (curly braces signal speech, not music).
      // Round brackets are music cues — never use them for dialogue lines.
      return `${who} says in ${language}, lips moving on camera: {${l.text}}`;
    })
    .join("\n");

  const LANGUAGE_DIRECTION =
    `All spoken dialogue is in ${language}, pronounced by native ${language} speakers with correct, ` +
    `clear, natural articulation. Speak the quoted lines exactly and verbatim, word for word, without ` +
    `translating, paraphrasing, mispronouncing, adding, dropping or altering any words. ` +
    `Do NOT read the character names or any text outside the quotation marks aloud.`;

  return `${base}\n\nThe characters speak the following lines out loud, on camera, in sync with their lip movements. ${LANGUAGE_DIRECTION}\n${spoken}\n\n${AUDIO_DIRECTION}`;
}

function findCharacter(speaker: string | null, characters: VoiceCharacter[]): VoiceCharacter | undefined {
  if (!speaker) return undefined;
  const s = speaker.toLowerCase();
  return (
    characters.find((c) => c.name.toLowerCase() === s) ??
    characters.find((c) => s.includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(s)) ??
    characters.find((c) => c.name.toLowerCase().split(/\s+/)[0] === s.split(/\s+/)[0])
  );
}

/** Voice settings tuned for lifelike, emotional acting (not flat narration). */
const ACTING_SETTINGS = {
  stability: Number(process.env.ELEVENLABS_STABILITY ?? 0.35),
  similarityBoost: Number(process.env.ELEVENLABS_SIMILARITY ?? 0.8),
  style: Number(process.env.ELEVENLABS_STYLE ?? 0.55),
};

/**
 * Render the whole scene dialogue as one MP3 buffer (or null when there is nothing to say).
 * Unknown speakers fall back to a voice derived from the speaker label itself, so two unknown
 * speakers still sound different.
 */
export async function renderSceneVoiceover(
  dialogue: string | null | undefined,
  characters: VoiceCharacter[]
): Promise<Buffer | null> {
  const lines = parseDialogue(dialogue);
  if (!lines.length) return null;

  const chunks: Buffer[] = [];
  for (const line of lines) {
    const character = findCharacter(line.speaker, characters) ?? { name: line.speaker ?? "narrator" };
    const voiceId = pickVoiceId(character);
    chunks.push(await generateSpeech(line.text, voiceId, ACTING_SETTINGS));
  }
  // MP3 frames are self-contained, so concatenating same-format buffers yields a valid stream.
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}
