/**
 * Background worker for Stage 4 "Scenes" — the ~12-shot breakdown of one episode.
 *
 * Stage 92: the scene prompts (videoPrompt) are now written by the strong reasoning model
 * gpt-6-astra (SCRIPT_MODEL) instead of gpt-4o. A gpt-6-astra completion of a 12-shot breakdown
 * with detailed 9-line video prompts spends several minutes and a SYNCHRONOUS call would die at
 * ~300 s (Node undici headers timeout, regardless of the SDK timeout — see lib/ai.ts). So this
 * step runs as a resumable GenerationJob (type "scenes"): the route creates the job and returns
 * its id; this worker starts an OpenAI BACKGROUND response (gpt-6-astra) and polls it from short
 * requests until it completes, then normalizes + persists the scenes. The client polls
 * GET /api/jobs/[id] and renders a smooth 0→100 % bar.
 *
 * The SYSTEM prompt / user-message building are the exact same content that used to live in the
 * synchronous route (app/api/ai/scenes/route.ts) — only the model and the sync→background wrapper
 * changed here.
 */
import { prisma } from "@/lib/db";
import {
  SCRIPT_MODEL,
  startBackgroundJSON,
  pollBackgroundJSON,
  cancelBackgroundResponse,
  chatJSON,
} from "@/lib/ai";
// Stage 167 — shot-plan persistence at the approval transition (see below).
import { persistShotPlanForApprovedEpisode } from "@/lib/workers/shot-plan-persist";
import {
  generateSeasonStateUpdate,
  seedSeasonState,
  normalizeSeasonState,
  SEASON_STATE_PROMPT_VERSION,
  type SeasonStateData,
  type SeedCastMember,
} from "@/lib/season-state";
import { normalizeDramaBible } from "@/lib/drama-bible";
import { updateJob, completeJob, failJob, heartbeatJob, markCanceled, isCancelRequested } from "@/lib/jobs";
import { VISUAL_STYLE } from "@/lib/visual-style";
import { anchorSceneLocation } from "@/lib/location-anchor";
import { DIRECTING_RULES } from "@/lib/directing-rules";
import {
  EPISODE_MAX_TOTAL_SECONDS,
  EPISODE_SCENE_COUNT,
  EPISODE_TOTAL_LABEL,
  SCENE_MIN_SECONDS,
  SCENE_CLIP_MAX_SECONDS,
  clampSceneDuration,
  applyFixedSceneDurations,
  episodeFootageGivens,
  parseEpisodeFootage,
  parseEpisodeSynopsis,
} from "@/lib/season";

/** GenerationJob.type value for the episode scene-breakdown job. */
export const SCENES_JOB_TYPE = "scenes";

/** Roughly how long the scene breakdown takes with gpt-6-astra — drives the smooth 0→100 % client bar. */
export const SCENES_EXPECTED_SEC = 240;

// Stage 115 — an episode is a FIXED number of shots (EPISODE_SCENE_COUNT = 9), but each shot's clip
// length is now VARIABLE: 5–10 s, as long as the depicted action / lines actually last. The whole
// episode is a CEILING of EPISODE_MAX_TOTAL_SECONDS (90 s = 1:30) — the sum of durations may be less.
// Every label below is DERIVED — nothing is hardcoded.
const SCENES_PER_EPISODE = EPISODE_SCENE_COUNT;
const SCENE_SECONDS = SCENE_CLIP_MAX_SECONDS;
const EPISODE_TOTAL_SECONDS = EPISODE_MAX_TOTAL_SECONDS;
/** "1:30" — the whole-episode running-time CEILING as m:ss (derived). */
const TOTAL_LABEL = EPISODE_TOTAL_LABEL;
/** Stage 115 — variable-length wording used in the structure sentence. */
const LAST_SHOT_TEXT = `each shot runs only as long as its action and lines actually last (${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s), never padded`;

/** Minimum number of purely visual beats (no spoken lines) per episode. */
const MIN_SILENT_SCENES = 0;
/** Maximum silent shots — Stage 110: ZERO. Every shot carries on-camera dialogue (aligned with lib/season.ts). */
const MAX_SILENT_SCENES = 0;

/**
 * Stage 115 — the episode structure sentence shared by the SYSTEM prompt and the user message
 * (exported so tests can check the derived labels without a DB): 9 shots, variable 5–10 s clips
 * summing to AT MOST 1:30, set-up → escalation.
 */
export const EPISODE_STRUCTURE_TEXT =
  `Every episode is EXACTLY ${SCENES_PER_EPISODE} shots and runs UP TO ${TOTAL_LABEL} (at most ${EPISODE_TOTAL_SECONDS} s) of total screen time: ` +
  `${LAST_SHOT_TEXT}; set each shot's durationSec to its real length and keep the sum of all durations at or under ${EPISODE_TOTAL_SECONDS} s. ` +
  `The FIRST half of the shots = the SET-UP — they carry the episode's continuation straight out of the previous episode's cliffhanger (episode 1: the season opening) and state this episode's conflict; ` +
  `the SECOND half = the ESCALATION — the conflict sharpens and the LAST shot ENDS on this episode's cliffhanger.`;

/** Stage 115 — a scene is rendered as a short VARIABLE-length clip (5–10 s) with Seedance native
 *  audio; the clip ends when the depicted action / lines end, never padded to a round number. */
const DIALOGUE_CLIP_SECONDS = SCENE_CLIP_MAX_SECONDS;

const SYSTEM = `You are a film director + cinematographer + editor working on a short-form VERTICAL drama series (9:16, TikTok/Reels format). ${EPISODE_STRUCTURE_TEXT}

${DIRECTING_RULES}

VISUAL TREATMENT FOR ALL NEW SHOTS: ${VISUAL_STYLE}
Preserve each character's own identity and story; never imitate a studio or franchise. Use only dialogue and natural ambience, never music.

THE CORE IDEA — SCENES ARE SHOTS, NOT MINI-STORIES:
An episode is ONE continuous piece of cinema. The ${SCENES_PER_EPISODE} "scenes" you write are ${SCENES_PER_EPISODE} CAMERA SHOTS (cuts) — each shot a short VARIABLE-length clip of ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s (as long as its action and lines actually last), together at most ${EPISODE_TOTAL_SECONDS} s — inside that single continuous sequence, exactly the way a film editor cuts between angles of the same unfolding action. Each shot is rendered as a separate ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s AI video clip WITH native speech and the clips are concatenated in order, so the viewer must experience them as ONE flowing film, never as unrelated clips glued together.

Given the project synopsis, this episode's description, and the characters, return ONLY valid JSON in this exact shape:

{
  "visualIdentity": "One sentence, English. The photorealistic look of the whole episode: cinematography, lighting, color grade, aspect. Use the VISUAL TREATMENT above, with a consistent lighting and color palette.",
  "characterSheet": {
    "CHARACTER_NAME": "Exact physical description used VERBATIM in every videoPrompt where this character appears. Example: 'YARA (early 20s, short black hair, olive skin, dark grey hoodie, silver stud earrings)'"
  },
  "scenes": [
    {
      "number": 1,
      "durationSec": 10,
      "shotType": "Wide establishing shot | Wide shot | Medium shot | Close-up | Extreme close-up | Over-the-shoulder | POV | Tracking shot | Reaction shot | Insert",
      "dialogue": "a back-and-forth EXCHANGE in ENGLISH with a delivery cue in parentheses on each line (never \"[NO DIALOGUE]\"):\\nCHARACTER_NAME (low, guarded): \\"Short line.\\"\\nCHARACTER2 (a tired sigh, barely a whisper): \\"Short reply.\\"\\nCHARACTER_NAME (leaning in): \\"One more beat.\\"",
      "locationDesc": "INT/EXT — Location — Time. Vivid, filmable description of the setting, HOW the light falls (source, direction, quality, shadows, colour temperature) and the atmosphere/ambience.",
      "videoPrompt": "[SHOT TYPE]: ...\\n[VISUAL STYLE]: ...\\n[LIGHTING]: ...\\n[BLOCKING]: ...\\n[GAZE]: ...\\n[NON-VERBAL]: ...\\n[ACTION]: ...\\n[CHARACTER]: ...\\n[TRANSITION]: ..."
    }
  ]
}

============ SHOT DESIGN RULES ============

1. RUNNING-TIME BUDGET (VARIABLE-LENGTH SHOTS). The episode is EXACTLY ${SCENES_PER_EPISODE} scenes; ${LAST_SHOT_TEXT}. Set "durationSec" per scene to the clip's REAL length — an integer ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s: a short beat is ${SCENE_MIN_SECONDS}–7 s, a full beat up to ${SCENE_CLIP_MAX_SECONDS} s. Keep the SUM of all "durationSec" at or under ${EPISODE_TOTAL_SECONDS} s (up to ${TOTAL_LABEL}); it need not reach it. NO scene may exceed ${SCENE_CLIP_MAX_SECONDS} s. NEVER pad a clip to a round number: the clip ENDS the instant its shown action / line finishes — a character must NOT hold a static pose, freeze or stare into the camera to fill time. Scene 1 opens on a wide or aerial ESTABLISHING SHOT (EXT — Location — Time, or a wide interior) that grounds the viewer in place, time and mood and defines the episode's visual identity — but someone is ALREADY talking in it (dialogue over the establishing shot), unless scene 1 is the single allowed silent beat.

2. SHOT PROGRESSION, NOT SCENE JUMPS. Think like a cinematographer covering one continuous action: wide → medium → close-up → reaction shot → back to medium → insert → ... Action, location and time flow CONTINUOUSLY from shot to shot: shot N+1 starts exactly where shot N ended (same room, same light, same positions, same props). A change of location/time is allowed ONLY when explicitly motivated and written into locationDesc as a transition ("CUT TO: 2 hours later —", "SMASH CUT TO: EXT —"). At most 1–2 such transitions per episode.

3. ONE CONSISTENT VISUAL IDENTITY. Define it in "visualIdentity" and repeat that SAME sentence (verbatim or near-verbatim) in the [VISUAL STYLE] line of EVERY videoPrompt. Same photorealistic treatment, lighting scheme and color palette in all ${SCENES_PER_EPISODE} shots — the cut must never feel like a different camera.

4. IDENTICAL CHARACTER DESCRIPTIONS. Build "characterSheet" first (age range, hair, skin, build, distinctive features, EXACT clothing for this episode). Then, in every videoPrompt where a character is visible, paste their characterSheet description WORD FOR WORD into [CHARACTER]. Never vary hair, clothes or features between shots. Use the character names given below.

5. EMOTIONAL CAMERA LANGUAGE — the camera must express the emotion of the beat:
   • Tension / fear: handheld, tight close-ups, rack focus, shallow depth of field, unsteady framing
   • Calm / intimacy: steady tripod or slow dolly, wide or medium shots, soft motion
   • Revelation / realization: slow zoom in, dramatic push-in on the face, held stare
   • Action / urgency: tracking shot, whip pan, dynamic following movement
   • Isolation / dread: wide shot with the character small in frame, negative space, static camera
   State the camera movement explicitly in [SHOT TYPE] / [ACTION].

6. TRANSITIONS — EVERY SHOT HANDS OFF TO THE NEXT. The [TRANSITION] line describes how this shot connects to the following one: what the camera lands on, what the character turns toward, what sound/motion carries over. Examples: "camera slowly pans right and settles on the closed door — the next shot opens on that door", "holds on her face as her eyes drop to the phone in her hand — next shot is the phone screen", "match cut: the glass she sets down becomes the glass on the lab table". The last shot's transition sets up the cliffhanger / next episode.

7. DIALOGUE — CHARACTERS TALK TO EACH OTHER. The audience bonds with the characters through what they say, so this is a DIALOGUE-DRIVEN series: NO scene is purely visual (max silent scenes = ${MAX_SILENT_SCENES}) — EVERY scene carries spoken English dialogue between the named characters on camera; never write "[NO DIALOGUE]".
   • REQUIRED: A REAL BACK-AND-FORTH EXCHANGE, NOT AN EMPTY LINE. Each talking scene MUST carry a short exchange between TWO characters — 1–2 lines that ANSWER each other (a line and a quick reply), written as SEPARATE "SPEAKER: line" lines. A talking scene with a weak throwaway line is WRONG — even a single line must carry a real story beat, and the whole point is that the characters converse. Alternate the speakers (A, then B).
   • MATCH THE CLIP TO ITS LINES — each talking scene is a short VARIABLE-length clip (${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s). Write only the lines the clip actually needs — one short line or a quick 1–2-line exchange (roughly 8–24 spoken words) — and set "durationSec" to how long that speech plus its visible action really lasts. Never cram a long speech into one clip, and never stretch a short beat: the clip ends when the line and its action end.
   • A CONVERSATION CAN SPAN SEVERAL CLIPS. A dialogue scene does NOT have to be self-contained: one clip may carry a single line (or short exchange) with visible action, then the NEXT scene CUTS to a new angle / shot and the reply continues — two characters talking, a cut, the next phrase. Spread a longer conversation across consecutive shots this way; a scene may end mid-conversation and the next scene picks it up. Keep continuity (each scene opens on the previous scene's final frame) and always change the camera on the cut.
   • TONE OF VOICE ON EVERY LINE. Give each spoken line a brief delivery cue in parentheses right after the speaker name: HOW it is said — the tone, emotion and manner (e.g. "(low, guarded)", "(a shaky whisper, holding back tears)", "(mockingly, half-laughing)", "(a tired sigh, then flat)"). These cues are performance directions only; they are NEVER spoken aloud and NEVER shown as subtitles.
   Follow a film rhythm, e.g.: establishing (silent) → exchange → reaction (silent) → exchange continues → insert → exchange → ...
   EXAMPLE of ONE talking scene's "dialogue" field (note: MULTIPLE lines that answer each other, each with a tone cue):
     ANSEL (guarded, not turning around): "You shouldn't be here."
     WREN (quiet, stepping closer): "Neither should you, after what happened."
     ANSEL (a bitter breath): "Say his name, then. Say it."

8. STORY. Dramatize ONLY the events of THIS episode's description — when the brief gives HARD BEATS (BEAT 1 / BEAT 2 / FINAL FRAME), the FIRST half of the scenes expand BEAT 1, the SECOND half expand BEAT 2, and the last frame of the FINAL scene IS the FINAL FRAME image: do not invent events beyond those three lines, only add dialogue, blocking, camera and business — do NOT borrow, foreshadow in detail, or resolve events from the other episodes listed (they are told in their own episodes). Open by picking up naturally from the previous episode's cliffhanger (given below) and build steadily toward THIS episode's cliffhanger, landing on it in the final shot. Dialogue is natural, subtext-rich, screenplay format.

============ videoPrompt FORMAT (English, always, exactly these 9 lines, in this order) ============
[SHOT TYPE]: <Wide establishing shot / Medium shot / Close-up / Over-the-shoulder / POV / Tracking shot / Reaction shot / Insert> + camera movement (static / slow dolly in / handheld / slow zoom / pan right ...), vertical 9:16 framing
[VISUAL STYLE]: <the visualIdentity sentence — identical in every scene>
[LIGHTING]: <HOW the light falls in THIS shot — light source(s) and direction (e.g. hard window light from camera-left, a single overhead bulb, warm street lamp, cold monitor glow), quality (hard/soft, diffused), where the shadows fall, highlights and rim light, and the colour temperature/palette; keep it consistent with [VISUAL STYLE]>
[BLOCKING]: <WHERE each character is placed and how they move — who stands / sits / leans and where in the frame (foreground/background, camera-left/right), the distance and spatial relationship between them, and any movement or gesture during the beat (steps closer, turns away, folds arms, sets something down)>
[GAZE]: <the EYELINES — who looks at whom or at what (e.g. "she stares straight into his eyes", "he looks down at the phone", "his eyes flick to the door", "she avoids his gaze, looking at the floor"); state each visible character's gaze direction>
[NON-VERBAL]: <the wordless performance — facial micro-expressions, sighs, breathing, swallowing, trembling, a tightening jaw, a flicker of a smile, tears welling, body language and posture that reveal the inner emotion of the beat>
[ACTION]: <exactly what happens across this short ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s shot, present tense, concrete and filmable; continuous natural motion throughout — the shot ENDS when the depicted action / line ends, with NO frozen final beat, no static pose held and no staring into the camera to fill time; include the emotion on faces>
[CHARACTER]: <verbatim characterSheet description of every visible character; write "none visible" for empty frames>
[TRANSITION]: <how this shot connects to the next shot>

Never mention real people, brands, logos or existing films/characters. No on-screen text, no subtitles, no music references.

============ ORIGINAL VISUAL DESIGN RULES ============
Describe original designs directly. These rules do not guarantee provider moderation approval:
- NEVER name real actors, celebrities, musicians, politicians, athletes, influencers or ANY real person — not as a lookalike either ("looks like Angelina Jolie", "a young Brad Pitt" are FORBIDDEN). Describe people generically and concretely instead: "a woman in her 30s with dark shoulder-length hair and sharp cheekbones".
- NEVER name directors, cinematographers, photographers or their signature styles ("Wes Anderson symmetry", "Fincher-esque", "Deakins lighting", "in the style of Kubrick"). Describe the technique itself: "perfectly centered symmetrical framing", "low-key cool-toned lighting with deep shadows", "slow push-in with shallow depth of field".
- NEVER reference specific films, TV series, games, anime, comics or their characters, worlds, props or scenes ("Blade Runner neon", "like the Matrix lobby scene", "a Joker-style grin", "Hogwarts-like castle"). Describe the imagery directly: "rain-soaked street lit by pink and cyan neon signs".
- NEVER name brands, products, logos, trademarks or branded gear — including phones, cars, sneakers, fashion labels, drinks, apps, camera bodies and film stocks ("iPhone", "BMW", "Nike", "Gucci", "Coca-Cola", "Netflix", "Arri Alexa", "Kodak Portra"). Use generic nouns: "smartphone", "black sedan", "plain white sneakers", "35mm film stock". No visible logos or text anywhere in frame.
- NEVER reference art styles by artist or studio name ("Van Gogh brushstrokes", "Rembrandt lighting", "Ghibli style", "Pixar look"). Describe the visual qualities: "thick expressive brushstrokes", "classic three-quarter portrait lighting", "soft hand-drawn animation look".
- Character names are the fictional names from the character list below — never a real person's full name.
If in doubt, DESCRIBE what the camera sees in plain, generic cinematic language. Prompts that break this rule are unusable.

============ LANGUAGE RULES ============
- "dialogue" and "locationDesc" are written in the SAME LANGUAGE as the synopsis / episode description (Russian synopsis → Russian dialogue and locations).
- "visualIdentity", "characterSheet" and "videoPrompt" are ALWAYS in English — they drive the AI video model.
- Exactly ${SCENES_PER_EPISODE} scenes, numbered 1..${SCENES_PER_EPISODE}, in shooting/screening order.`;

export interface ScenesJobResult {
  scenes: any[];
  visualIdentity: string;
  characterSheet: Record<string, string>;
}

/**
 * Stage 128 — the episode brief inside the user message. New format: the description is ONE detailed continuous
 * synopsis; the scenes expand it in order and the LAST FRAME of the final scene = the cliffhanger image. Legacy
 * episodes still saved as episode footage (BEAT 1 / BEAT 2 / CLIFFHANGER) keep the old HARD BEATS brief.
 */
export function episodeBriefBlock(episode: { number: number; title: string; description: string | null; cliffhanger: string | null }): string {
  const head = `Episode ${episode.number}: "${episode.title}"`;
  const beats = episodeFootageGivens(episode.description);
  if (beats) {
    const f = parseEpisodeFootage(episode.description)!;
    return `${head}${beats}\nThis episode's ending cliffhanger (the LAST FRAME of the final scene IS this image): ${f.cliffhanger}${episode.cliffhanger && episode.cliffhanger.trim() !== f.cliffhanger ? ` (${episode.cliffhanger})` : ""}`;
  }
  // New format (or plain prose): use the continuous synopsis as the brief; the cliffhanger is the last-frame target.
  const { synopsis, cliffhanger } = parseEpisodeSynopsis(episode.description);
  const cliff = (episode.cliffhanger?.trim() || cliffhanger || "").trim();
  return `${head}\nDescription (a continuous synopsis — break it into the scenes in order, do NOT invent events beyond it): ${synopsis || episode.description || ""}\nThis episode's ending cliffhanger (the LAST FRAME of the final scene builds toward this image): ${cliff || "N/A"}`;
}

/**
 * Build the exact user message the synchronous route used to send (unchanged content).
 */
async function buildUserMessage(projectId: string | undefined, episodeId: string): Promise<{ userMsg: string } | { error: string }> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: { season: { include: { project: true } } },
  });
  if (!episode) return { error: "Episode not found" };

  const pid = projectId || episode.season?.projectId;
  const synopsis = episode.season?.project?.synopsis ?? "";

  const seasonEpisodes = episode.seasonId
    ? await prisma.episode.findMany({
        where: { seasonId: episode.seasonId },
        orderBy: { number: "asc" },
        select: { number: true, title: true, description: true, cliffhanger: true },
      })
    : [];

  const episodeListText = seasonEpisodes
    .map(
      (e) =>
        `  Episode ${e.number}: "${e.title}" — ${e.description ?? "(no description)"}${
          e.number === episode.number ? "   <<< THIS EPISODE — dramatize ONLY this" : ""
        }`
    )
    .join("\n");

  const prevEpisode = seasonEpisodes
    .filter((e) => e.number < episode.number)
    .sort((a, b) => b.number - a.number)[0];
  const prevContext = prevEpisode
    ? `Previous Episode ${prevEpisode.number} ("${prevEpisode.title}") ended on this cliffhanger — continue naturally from it:\n"${prevEpisode.cliffhanger ?? prevEpisode.description ?? "N/A"}"`
    : "This is the FIRST episode — open the story from the beginning.";

  const characters = await prisma.character.findMany({
    where: { projectId: pid },
    select: { name: true, role: true, description: true, appearance: true, personality: true, age: true, firstAppearance: true },
  });

  const charSummary = characters
    .map((c) => {
      const extra = [
        c.age ? `Age: ${c.age}` : "",
        c.personality ? `Personality: ${c.personality}` : "",
        c.firstAppearance && c.firstAppearance !== c.description ? `First appears: ${c.firstAppearance}` : "",
      ].filter(Boolean);
      return `- ${c.name} (${c.role}): ${c.description ?? ""}. Appearance: ${c.appearance}${extra.length ? ". " + extra.join(". ") : ""}`;
    })
    .join("\n");

  const projectLanguage = episode.season?.project?.language;
  const languageHint = projectLanguage
    ? `\nProject language: "${projectLanguage}" — write "dialogue" and "locationDesc" in this language.`
    : "";

  const userMsg = `Project synopsis: ${synopsis}${languageHint}

Characters:
${charSummary || "No characters defined yet."}

Full episode list for this season (for scope only — each episode is told in its OWN episode, do NOT borrow their events):
${episodeListText || "  (single episode)"}

${prevContext}

>>> GENERATE SCENES ONLY FOR THIS EPISODE <<<
${episodeBriefBlock(episode)}

Direct this episode as ONE continuous piece of film: first write "visualIdentity" and the "characterSheet", then exactly ${SCENES_PER_EPISODE} consecutive camera shots (the first half = set-up continuing the previous cliffhanger, the second half = escalation ending on this episode's cliffhanger). ${LAST_SHOT_TEXT} — set "durationSec" per shot to its REAL length (an integer ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s) and keep the SUM of all durations at or under ${EPISODE_TOTAL_SECONDS} s (up to ${TOTAL_LABEL}); never pad a clip to fill time. Scene 1 = wide establishing shot with someone ALREADY talking; NO shot marked [NO DIALOGUE] (max silent = ${MAX_SILENT_SCENES}), EVERY shot carrying its own dialogue — one short line or a quick 1–2-line exchange (the characters ANSWER each other — never a weak throwaway line), each spoken line on its own "SPEAKER (tone): line" row; a longer conversation is spread across several consecutive shots, one line (or short exchange) per shot with a camera cut between them; every videoPrompt in the full 9-line format — [SHOT TYPE], [VISUAL STYLE] (identical every scene), [LIGHTING], [BLOCKING], [GAZE], [NON-VERBAL], [ACTION], [CHARACTER] (verbatim descriptions), [TRANSITION] handing off to the next shot) that dramatize ONLY this episode's description — from a natural continuation of the previous episode to this episode's cliffhanger.`;

  return { userMsg };
}

/**
 * Persist the model output into scenes exactly as the old synchronous route did:
 * normalize (sequential numbering, trim to the target count, guaranteed [VISUAL STYLE] line),
 * clear existing scenes and recreate them anchored to the episode's canonical location.
 */
async function persistScenes(episodeId: string, data: { visualIdentity?: string; characterSheet?: Record<string, string>; scenes?: any[] }): Promise<ScenesJobResult> {
  const episode = await prisma.episode.findUnique({ where: { id: episodeId } });
  if (!episode) throw new Error("Episode not found");

  const rawScenes = Array.isArray(data?.scenes) ? data.scenes : [];
  if (rawScenes.length === 0) throw new Error("Model returned no scenes");

  const visualIdentity = (data.visualIdentity ?? "").trim();
  const characterSheet = data.characterSheet ?? {};

  const trimmed = rawScenes.slice(0, SCENES_PER_EPISODE);
  // Stage 115 — variable-length clips: take each scene's OWN durationSec (5–10 s from the script model),
  // clamp it into [SCENE_MIN_SECONDS, SCENE_CLIP_MAX_SECONDS], and trim the longest clips only if the
  // whole episode would exceed the 90 s ceiling. Never force a fixed length.
  const durationHolders = trimmed.map((s) => ({ durationSec: clampSceneDuration(Number(s?.durationSec)) }));
  applyFixedSceneDurations(durationHolders);
  const durations = durationHolders.map((h) => h.durationSec ?? SCENE_MIN_SECONDS);
  const scenesOut = trimmed.map((s, i) => {
    let videoPrompt = String(s?.videoPrompt ?? "").trim();
    if (visualIdentity && !/\[VISUAL STYLE\]/i.test(videoPrompt)) {
      videoPrompt = `[VISUAL STYLE]: ${visualIdentity}\n${videoPrompt}`;
    }
    const dialogue = String(s?.dialogue ?? "").trim() || "[NO DIALOGUE]";
    return {
      number: i + 1,
      durationSec: durations[i],
      dialogue,
      locationDesc: String(s?.locationDesc ?? "").trim(),
      videoPrompt,
    };
  });

  const silentCount = scenesOut.filter((s) => /\[NO DIALOGUE\]|\[VISUAL MONTAGE\]/i.test(s.dialogue)).length;
  const establishing = /establishing|wide|aerial|drone/i.test(scenesOut[0]?.videoPrompt ?? "");
  console.log(
    `[scenes] ${episodeId}: ${scenesOut.length}/${SCENES_PER_EPISODE} shots, silent=${silentCount} (target ${MIN_SILENT_SCENES}–${MAX_SILENT_SCENES}), ` +
      `establishing=${establishing}, identity="${visualIdentity.slice(0, 60)}", characters=${Object.keys(characterSheet).join("/")}`
  );

  // Stage 105 — a rewritten script replaces ALL scenes of the episode (their videos, keyframes and last
  // frames go with the rows; S3 objects are left alone) and the stitched episode video becomes stale →
  // Episode.videoUrl = null. One transaction so a failure never leaves a half-replaced episode.
  const created = await prisma.$transaction(async (tx) => {
    await tx.scene.deleteMany({ where: { episodeId } });
    await tx.episode.update({ where: { id: episodeId }, data: { videoUrl: null } });
    const rows = [];
    for (const s of scenesOut) {
      const scene = await tx.scene.create({
        data: {
          episodeId,
          number: s.number,
          durationSec: s.durationSec,
          dialogue: s.dialogue,
          // Stage 20 (A2): lock scenes to the episode's single canonical location so the place never drifts.
          locationDesc: anchorSceneLocation(s.locationDesc, episode.locationDesc, undefined),
          videoPrompt: s.videoPrompt,
          status: "pending",
        },
      });
      rows.push(scene);
    }
    return rows;
  }, { timeout: 30_000 });

  return { scenes: created, visualIdentity, characterSheet };
}

/**
 * Run the episode scene-breakdown in the background of the calling serverless invocation.
 * Starts a gpt-6-astra BACKGROUND response and polls it with heartbeats until it completes,
 * then normalizes + persists the scenes and completes the job with { scenes, visualIdentity }.
 */
export async function runScenesJob(jobId: string, projectId: string | undefined, episodeId: string): Promise<void> {
  try {
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 8, message: "Directing the episode shot list…" });

    const built = await buildUserMessage(projectId, episodeId);
    if ("error" in built) { await failJob(jobId, built.error); return; }

    // Start the gpt-6-astra background response. reasoningEffort "low": the breakdown is largely a
    // formatting/craft task, and reasoning tokens count toward the output budget — keeping the effort
    // low leaves ample room for the full 12-shot JSON (which is large) without truncation.
    let responseId: string;
    try {
      responseId = await startBackgroundJSON(SYSTEM, built.userMsg, {
        model: SCRIPT_MODEL,
        maxTokens: 28000,
        reasoningEffort: "low",
      });
    } catch (err: any) {
      console.error("[scenes] failed to start background response:", err);
      await failJob(jobId, "Failed to start scene generation: " + (err?.message ?? "Unknown error"));
      return;
    }

    // Poll from short requests (each avoids the ~300 s synchronous undici timeout).
    let data: { visualIdentity?: string; characterSheet?: Record<string, string>; scenes?: any[] } | null = null;
    while (!data) {
      if (await isCancelRequested(jobId)) {
        await cancelBackgroundResponse(responseId);
        await markCanceled(jobId);
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
      await heartbeatJob(jobId);
      const res = await pollBackgroundJSON<{ visualIdentity?: string; characterSheet?: Record<string, string>; scenes?: any[] }>(responseId);
      if (res.status === "running") continue;
      if (res.status === "failed") { await failJob(jobId, "Scene generation failed: " + res.error); return; }
      data = res.json;
    }

    await updateJob(jobId, { progress: 85, message: "Saving scenes…" });
    let result: ScenesJobResult;
    try {
      result = await persistScenes(episodeId, data);
    } catch (err: any) {
      console.error("[scenes] persist failed:", err);
      await failJob(jobId, "Scene generation failed: " + (err?.message ?? "Unknown error"));
      return;
    }

    // Stage 4 (task Stage 4) — moving an episode into the scene breakdown is the practical APPROVAL of its
    // script. Refresh the season's live WORLD-STATE from the approved script (separate gpt-6-astra call,
    // generate→validate→targeted-retry) so the NEXT episode is written from the updated state. Fully
    // non-blocking + defensive: any failure is swallowed so it can never break scene generation.
    try {
      await updateSeasonStateForApprovedEpisode(episodeId);
    } catch (err: any) {
      console.error("[scenes] season-state update skipped:", err?.message ?? err);
    }

    // Stage 167 — at the SAME approval transition, plan and persist this episode's SHOT rows (the atomic
    // units of generation, one level below the scene) so the per-shot chain (video-job → assembly-job)
    // has something to iterate. Idempotent (re-approving rebuilds the shot list) + fully non-blocking:
    // any failure degrades to "no shots" and the episode still plays through the legacy scene fallback.
    try {
      const shotPlan = await persistShotPlanForApprovedEpisode(episodeId);
      console.log(`[scenes] shot plan persisted for episode ${episodeId}:`, shotPlan);
    } catch (err: any) {
      console.error("[scenes] shot-plan persist skipped:", err?.message ?? err);
    }

    // Keep episodeId in resultData so the idempotency / resume lookups (which match on episodeId)
    // still find this job after it completes.
    await completeJob(jobId, { ...result, episodeId }, "Scenes ready");
  } catch (err: any) {
    console.error("[scenes] job error:", err);
    await failJob(jobId, "Generation failed: " + (err?.message ?? "Unknown error"));
  }
}

/**
 * Stage 4 (task Stage 4) — refresh the season's live WORLD-STATE after an episode's script is approved
 * (moved into the scene breakdown). Loads the season's newest SeasonState (or seeds an initial one from the
 * project cast + drama bible when none exists), asks gpt-6-astra to fold the approved script into it (with the
 * contradiction validator + targeted retry), and appends the updated state as a new SeasonState row
 * (append-only; the newest row wins in the next-episode prompt). NEVER throws to the caller — the caller
 * already wraps it, and every failure mode degrades to "keep the previous state".
 */
export async function updateSeasonStateForApprovedEpisode(episodeId: string): Promise<void> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: {
      season: { include: { project: { include: { characters: { orderBy: { createdAt: "asc" } } } } } },
    },
  });
  if (!episode || !episode.season) return;
  const season = episode.season;
  const scriptText = (episode.script ?? "").trim();
  if (!scriptText) return; // nothing to fold in — keep the previous state

  // Current state: the newest persisted SeasonState row, else a freshly seeded initial state.
  const existing = await prisma.seasonState.findFirst({ where: { seasonId: season.id }, orderBy: { updatedAt: "desc" } });
  let currentState: SeasonStateData;
  if (existing?.state) {
    currentState = normalizeSeasonState(existing.state);
  } else {
    const cast: SeedCastMember[] = (season.project?.characters ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      appearance: c.appearance ?? null,
    }));
    const bible = season.project?.dramaBible ? normalizeDramaBible(season.project.dramaBible) : null;
    currentState = seedSeasonState(cast, bible);
  }

  // Fold the approved script into the state on gpt-6-astra (SCRIPT_MODEL). chatJSON returns parsed JSON.
  const result = await generateSeasonStateUpdate(
    {
      currentState,
      episodeScript: scriptText,
      seasonTitle: season.title ?? null,
      episodeNumber: episode.number,
      episodeTitle: episode.title ?? null,
    },
    (system, user, opts) => chatJSON<unknown>(system, user, { model: opts?.model ?? SCRIPT_MODEL, maxTokens: 8000 }),
    { model: SCRIPT_MODEL },
  );

  // Persist regardless of valid flag: an invalid-but-normalized state is still better continuity than the old
  // text tail, and the version records which prompt family produced it. Append-only (newest row wins).
  await prisma.seasonState.create({
    data: {
      seasonId: season.id,
      reflectsEpisodeNumber: episode.number,
      state: result.state as unknown as object,
      version: result.version ?? SEASON_STATE_PROMPT_VERSION,
    },
  });
}
