/** Dialogue parsing, language selection and Seedance native-audio prompt building. */
export interface DialogueLine {
  speaker: string | null;
  text: string;
  /** Delivery cue captured from the speaker parenthetical, e.g. "low, guarded".
   *  Drives HOW the line is spoken in the native-audio prompt. Never spoken aloud
   *  and never shown in subtitles. */
  tone?: string;
}

export interface VoiceCharacter {
  name: string;
  description?: string | null;
  role?: string | null;
  personality?: string | null;
  appearance?: string | null;
}

const NO_DIALOGUE_RE = /^\s*\[?\s*(no\s+dialogue|без\s+диалога|без\s+діалогу|silence|тишина)\s*\]?\s*\.?\s*$/i;
/** "YARA:" / "YARA (whispering):" / "Yara (V.O.):" — label is 1-4 words, optional parenthetical, then a colon/dash. */
const SPEAKER_RE = /^\s*([A-ZА-ЯЁІЇЄҐ][\p{L}\p{N}_'’.\-]*(?:\s+[A-ZА-ЯЁІЇЄҐ][\p{L}\p{N}_'’.\-]*){0,3})\s*(\([^)]*\))?\s*[:—–-]\s*/u;
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

    let tone: string | undefined;
    const m = line.match(SPEAKER_RE);
    if (m) {
      currentSpeaker = m[1].trim();
      // The optional parenthetical after the speaker name is the delivery cue
      // (tone / manner), e.g. "THEO (low, guarded):". Capture it — it drives HOW
      // the line is spoken, but is stripped from the spoken text and subtitles.
      if (m[2]) tone = m[2].replace(/^\(|\)$/g, "").trim() || undefined;
      line = line.slice(m[0].length);
    }

    const text = line.replace(DIRECTION_RE, " ").replace(/\s+/g, " ").trim().replace(QUOTES_RE, "").trim();
    if (!text) continue;

    // Merge consecutive lines of the same speaker into one utterance (keep the
    // first tone cue we saw for that speaker turn).
    const last = lines[lines.length - 1];
    if (last && last.speaker === currentSpeaker) {
      last.text += " " + text;
      if (!last.tone && tone) last.tone = tone;
    } else {
      lines.push({ speaker: currentSpeaker, text, ...(tone ? { tone } : {}) });
    }
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
        `Keep the exact same line structure: preserve "Speaker:" name prefixes (do NOT translate character names), ` +
        `keep any [stage directions] in brackets, and keep every (delivery/tone cue) in parentheses right after the ` +
        `speaker name — you MAY translate the words inside those cues but must keep the parentheses and their position. ` +
        `Translate ONLY the spoken words and the tone cues, naturally and idiomatically ` +
        `for ${targetLanguage}. Return ONLY the translated dialogue block, nothing else.`,
      block,
      { temperature: 0.3, maxTokens: 2048 }
    );
    return (out ?? "").trim() || block;
  } catch {
    return block;
  }
}

export interface NativeAudioOptions {
  /**
   * Stage 38: the scene is a fight / chase / physical struggle — the lines are short and delivered
   * only in the pauses between impacts, never while striking, dodging or falling.
   */
  action?: boolean;
}

export function buildNativeAudioPrompt(
  basePrompt: string,
  dialogue: string | null | undefined,
  characters: VoiceCharacter[],
  explicitLanguage?: string,
  options: NativeAudioOptions = {}
): string {
  const base = (basePrompt ?? "").trim();
  const lines = parseDialogue(dialogue);

  // Replicate Seedance 2.5 input schema: dialogue uses ordinary double quotes.
  const AUDIO_DIRECTION =
    "AUDIO TRACK: dialogue and ambient sound only. " +
    "NO background music. NO score. NO instrumental track. NO soundtrack. NO musical theme. " +
    "Only the characters' voices (spoken on camera by the visible characters) and the natural ambient sound of the location. " +
    "No narration voiceover. No on-screen text or subtitles.";

  if (!lines.length) {
    // No dialogue — ambient sound only.
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
      // The tone cue (from the "(low, guarded)" parenthetical) tells the model HOW
      // to deliver the line; it is a performance direction, never spoken aloud.
      const manner = l.tone ? `, ${l.tone},` : "";
      // Plain quoted dialogue; no undocumented bracket semantics. Stage 38: "on camera" only — whether
      // the speaker's mouth is in frame is decided by the staging, not by the audio direction.
      return `${who} says in ${language}${manner} on camera: "${l.text}"`;
    })
    .join("\n");

  const LANGUAGE_DIRECTION =
    `All spoken dialogue is in ${language}, pronounced by native ${language} speakers with correct, ` +
    `clear, natural articulation. Speak the quoted lines exactly and verbatim, word for word, without ` +
    `translating, paraphrasing, mispronouncing, adding, dropping or altering any words. ` +
    `Do NOT read the character names or any text outside the quotation marks aloud. ` +
    `Delivery is natural and relaxed — a real, unhurried conversational tempo with the normal small pauses between lines, never rushed, sped up or crammed — while still speaking every line clearly and fully within the clip.`;

  // Stage 38: the speaker's face / lips do NOT have to be in frame — the framing follows the staging
  // (profile, over the shoulder, from behind, a wide shot are all fine); when the mouth IS visible the
  // lip movements match the words. Action scenes: lines only in the pauses between impacts.
  const SPEECH_STAGING = options.action
    ? "The characters speak the following lines out loud, on camera. This is an ACTION scene: the lines are short and are delivered ONLY in the pauses between impacts — never while striking, dodging, blocking or falling. The speaker's face does not have to face the camera; whenever the speaker's mouth is visible its movements match the words exactly."
    : "The characters speak the following lines out loud, on camera. Whether the speaker's face is in frame depends on the staging — a line may be delivered in profile, over the shoulder, from behind or in a wide shot; whenever the speaker's mouth IS visible, its movements match the words exactly.";
  return `${base}\n\n${SPEECH_STAGING} ${LANGUAGE_DIRECTION}\n${spoken}\n\n${AUDIO_DIRECTION}`;
}

/**
 * Stage 12 (Commit D): build the prompt for an OFF-SCREEN NARRATION scene.
 * An English narrator reads `voiceover` verbatim over atmospheric b-roll — there is NO on-camera
 * dialogue, NO lip-sync, NO talking heads, NO music and NO subtitles. Used mainly for the episode-1
 * opening backstory (and an optional episode-2 catch-up).
 */
export function buildNarrationAudioPrompt(basePrompt: string, voiceover: string | null | undefined): string {
  const base = (basePrompt ?? "").trim();
  const text = (voiceover ?? "").trim();
  if (!text) {
    // Defensive: no narration text → treat as ambient-only b-roll.
    return `${base}\n\nAUDIO TRACK: ambient sound and room tone of the location only. NO background music. NO score. NO soundtrack. No voiceover. No subtitles.`;
  }
  const NARRATION_DIRECTION =
    "AUDIO TRACK: a single OFF-SCREEN NARRATOR voice-over in English, plus the natural ambient sound of the location. " +
    "The narrator is NOT on camera and NOT any visible character — nobody's lips move to these words. " +
    "Read the narration exactly and verbatim, word for word, in clear, natural English, without translating, " +
    "paraphrasing, adding or dropping any words, at a calm measured storytelling pace so it finishes before the clip ends. " +
    "NO on-camera dialogue, NO lip-sync, NO talking heads. NO background music. NO score. NO instrumental track. NO soundtrack. No on-screen text or subtitles.";
  return `${base}\n\nAn off-screen narrator speaks the following narration in English over the footage (voice-over only, no visible speaker, no lip movement):\n"${text}"\n\n${NARRATION_DIRECTION}`;
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
