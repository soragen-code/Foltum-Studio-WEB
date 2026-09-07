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
