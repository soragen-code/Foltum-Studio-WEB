/**
 * Single source of truth for the FINAL Seedance video prompt of a scene.
 *
 * `buildScenePrompt` is a PURE function (no network, no LLM, no DB): given the scene, its
 * characters, the episode location and the previous scene, it assembles EXACTLY the prompt the
 * video worker submits to Seedance — the styled visual prompt, the native-audio / narration
 * speech block, the pace direction and the ordered `[Image1]…[ImageN]` reference notes. The
 * assembled prompt is submitted VERBATIM (no moderation softening) so the physical/dramatic action
 * the script wrote survives; a manual per-scene override, when present, replaces the text.
 *
 * It is used by two callers so a preview can never drift from what is actually generated:
 *   1. lib/workers/video-job.ts — the real generation path.
 *   2. app/api/ai/scenes/[sceneId]/prompt — the authorized "show full prompt" preview.
 *
 * What stays OUTSIDE this function (worker-only, impure): translating legacy non-English dialogue
 * (translateDialogue), camera-only editing of a completed predecessor frame and substituting real
 * reference URLs. The preview never does any of those — it uses the stored scene fields as-is and
 * only ever emits `[ImageN]` placeholders, so no real reference URL is exposed to the client.
 */
import { buildNativeAudioPrompt, buildNarrationAudioPrompt, parseDialogue } from "@/lib/voiceover";
import { PACE_DIRECTION, ACTION_PACE_DIRECTION, CONFRONTATION_STAGING_SENTENCE } from "@/lib/season";
import { transliterateCyrillic } from "@/lib/sanitize-prompt";
import { styledVisualPrompt, isStyledAsset, locationAngleImages, parseLocationExtra, locationExtraLabel, locationLayoutNote } from "@/lib/visual-style";
import { normalizeVideoModel, videoModelSlug, type VideoModelId } from "@/lib/ai-models";
import { matchPropsInText, type PropRegistryEntry } from "@/lib/prop-registry";
import { stagingContinuityBlock } from "@/lib/staging-map";

/** Seedance limit. Stage 112 order: re-angle (if predecessor), cast, wide, layout, crowd. */
export const REFERENCE_IMAGE_CAP = 30;
/** Stage 44 — how many extra location angles (Location.imageExtra) may join the three base angles as references. */
export const LOCATION_EXTRA_REF_CAP = 6;
/** Stage 44 — the note appended when location references are sent: the characters are INSIDE the photographed place. */
export const LOCATION_INSIDE_NOTE =
  "Camera stays inside this location across the whole shot; lighting, weather, time of day and palette identical to the location references. Only the camera angle changes between shots. These frames are the SAME real place photographed from different positions — the characters are INSIDE this space: floor under their feet, walls/objects beside and behind them, real depth in front and behind; shoot them in wide/full shots within the environment, never as figures placed in front of a picture of the place. They interact with its objects and surfaces; the cuts show the same location from different angles with real depth (foreground, characters, background) — never a flat backdrop.";
/** @deprecated alias kept for older imports — use REFERENCE_IMAGE_CAP. */
export const MAX_REFERENCE_IMAGES = REFERENCE_IMAGE_CAP;
/** Stage 112: only a camera edit of the ACTUAL predecessor frame can lead video references. */
export const REANGLE_REFERENCE_NOTE = "the OPENING FRAME: the actual previous video's final instant already re-rendered from THIS shot's new camera. Match this camera/composition at frame 1; do not re-angle it again. Then immediately perform this scene's action and dialogue, without freezing.";
/** Stage 122 — the note attached to the pre-generated REGION PLATE reference: the authoritative environment /
 *  geometry for THIS scene's part of the location. It fixes background and layout ONLY (never poses or the shot's
 *  camera), and the camera stays free. This is what removes the environment's dependence on the fragile re-angle. */
export const REGION_PLATE_NOTE =
  "REGION PLATE — the authoritative ENVIRONMENT and GEOMETRY for THIS scene's part of the location (a controlled re-frame of the master plates onto this region). Reproduce its walls, floor, columns, fixtures and the fixed furniture EXACTLY as shown, at the same places, with any wall-adjacent furniture kept flush against its wall; match its architecture, materials, colours and lighting. Do NOT add, remove or rearrange furniture and do NOT replace walls with columns, pillars, openings or open space. This plate defines the BACKGROUND and LAYOUT ONLY — it does NOT dictate any character's pose, and it is NOT the camera angle of this shot: the camera is free to move anywhere within this same environment.";

export interface ScenePromptScene {
  id: string;
  number: number;
  videoPrompt: string | null;
  sceneKind?: string | null;
  voiceover?: string | null;
  dialogue?: string | null;
  dialogueEn?: string | null;
  language?: string | null;
  locationDesc?: string | null;
  continuesFrom?: string | null;
  /** Stage 113 — the scripted action text; used (with videoPrompt/dialogue) to match the location's set objects. */
  action?: string | null;
  /** Stage 41 — scripted START state of this scene's first frame (its own OPENING STATE unless the previous scene has an actual last-frame description). */
  startState?: string | null;
  /** Stage 40/41 — scripted END state of this scene's final frame; appended to the prompt as END STATE. */
  endState?: string | null;
  /**
   * Stage 31: manual final-prompt override. When non-empty it REPLACES the auto-assembled prompt
   * TEXT verbatim (no moderation softening, no `[ImageN]` notes appended); the reference image set
   * is still computed and SENT as usual. null/empty = use the auto prompt.
   */
  promptOverride?: string | null;
  /**
   * Stage 36: when true the video is submitted text-only for ANY scene — no character / location
   * references, no crowd groups, no `[ImageN]` notes, no Flux still.
   */
  skipReferences?: boolean | null;
  /**
   * Stage 37 flag, OBSOLETE since Stage 38: the previous scene's frame is never sent any more, so this
   * has no effect. Kept optional so older callers / stored rows still type-check.
   */
  skipPreviousFrame?: boolean | null;
}

export interface ScenePromptCharacterLink {
  characterId: string;
  name: string;
  tier?: string | null;
  imageFront?: string | null;
  /** Stage 46B-1 — styled full-body reference; sent after imageFront/imageProfile for individuals (build, proportions, current clothing). */
  imageFull?: string | null;
  /** Stage 46B-2 — styled profile (side view) reference; sent between the front and the full body. */
  imageProfile?: string | null;
  /** Stage 46B-2 — JSON array of extra angle URLs (Character.imageExtra); sent after the full body. */
  imageExtra?: string | null;
  /** Stage 46B-0 — CURRENT saved appearance / age of the live Character row (rebuilds the [CHARACTER] line). */
  appearance?: string | null;
  age?: string | null;
}

/**
 * Stage 46B-0 — the `[CHARACTER]:` line of a stored Scene.videoPrompt is written ONCE at script time
 * (LLM or normalizeEpisodeScript) and therefore describes the character version of THAT moment. The
 * scene job must always describe the CURRENT saved version, so the line is rebuilt here from the live
 * Character rows (`Name (age): appearance; ...`) every time the prompt is assembled. Characters without
 * an appearance text contribute nothing; if none has one the stored line is kept as is.
 */
export function liveCharacterLine(characters: ScenePromptCharacterLink[]): string | null {
  const parts = characters
    .filter(c => (c.appearance ?? "").trim().length > 0)
    .map(c => `${c.name.trim()}${(c.age ?? "").trim() ? ` (${(c.age ?? "").trim()})` : ""}: ${(c.appearance ?? "").trim().replace(/\s*\n+\s*/g, " ")}`);
  return parts.length ? `[CHARACTER]: ${parts.join("; ")}` : null;
}

/**
 * Replace the stored `[CHARACTER]:` line with the live one. `insertIfMissing` (auto prompts) appends the
 * line before `[TRANSITION]` / at the end when the stored prompt has none; a manual override is only
 * touched when it still contains a `[CHARACTER]:` line (the producer's free text is otherwise kept verbatim).
 */
export function refreshCharacterLine(prompt: string, characters: ScenePromptCharacterLink[], insertIfMissing = true): string {
  const line = liveCharacterLine(characters);
  if (!line) return prompt;
  const re = /\[CHARACTER\]:[^\n]*/i;
  if (re.test(prompt)) return prompt.replace(re, line);
  if (!insertIfMissing) return prompt;
  const idx = prompt.indexOf("[TRANSITION]");
  return idx >= 0 ? `${prompt.slice(0, idx)}${line}\n${prompt.slice(idx)}` : `${prompt}\n${line}`;
}

export interface ScenePromptLocation {
  id: string;
  name: string;
  imageUrl?: string | null;
  imageReverse?: string | null;
  imageDetail?: string | null;
  /** Stage 44 — JSON array of extra location angles (Location.imageExtra); sent as references too. */
  imageExtra?: string | null;
  /** Stage 113 — Location.setInventory (one "object — placement" per line); null for legacy rows. */
  setInventory?: string | null;
}

/**
 * The adjacent previous scene. Stage 38: its last frame IMAGE is never sent. Stage 40: its END STATE
 * text is — `endStateActual` (vision description of the real last frame, chain mode) wins over the
 * scripted `endState`; the winner opens the next scene's prompt as OPENING STATE.
 */
export interface ScenePromptPrevious {
  id: string;
  number: number;
  locationDesc?: string | null;
  lastFrameUrl?: string | null;
  endState?: string | null;
  endStateActual?: string | null;
}

/** Stage 40 — `continuesFrom` values that START a new visual sequence (no opening-state hand-off). */
export const SEQUENCE_BREAK_LINKS = ["location-change", "new-sequence"] as const;
export function breaksSequence(continuesFrom?: string | null): boolean {
  const k = (continuesFrom ?? "").trim().toLowerCase();
  return (SEQUENCE_BREAK_LINKS as readonly string[]).includes(k);
}

/** Stage 40 — prefix of the OPENING STATE block inserted before the 9-line visual prompt. */
export const OPENING_STATE_PREFIX = "OPENING STATE (frame 1 — the SAME instant and action continue from the previous shot, but from a NEW camera: different angle, shot scale and height — never the previous framing; re-frame the identical moment): ";
/** Stage 44 — directive appended on every continuous seam: match cut on action, new camera, nobody speaking on frame 1. */
export const NEW_CAMERA_ON_CUT_LINE =
  "NEW CAMERA ON THE CUT: this shot opens on the exact same action as the previous shot's final instant, but the camera has cut to a different angle / shot scale / height — never the same framing as the previous shot's end. Nobody is speaking on frame 1 — the first line of this shot starts fresh after the cut.";
/** Stage 44 — speech must be finished before the final second of every clip (no mid-word cuts). */
export const SPEECH_BEFORE_CUT_LINE =
  "All speech is finished before the final second of the clip — nobody is mid-word or mid-sentence at the cut; the last line lands, then the hard cut.";
/** Stage 41 — prefix of the END STATE block inserted after OPENING STATE, before the 9-line visual prompt. */
export const END_STATE_PREFIX = "END STATE (last frame — end exactly here): ";
/** Stage 115 — anti-freeze: the clip runs on continuous motion and cuts the instant the action / line ends, never padding to length with a held pose or a stare into the camera. */
export const NO_FROZEN_PADDING_LINE =
  "NO FROZEN PADDING: the clip is filled edge to edge with continuous, natural motion and cuts the instant the shown action and lines finish — its length matches its content, so it may run short. Do NOT stretch it to a fixed length: nobody holds a static pose, freezes, or stares into the camera at the end waiting for the cut, and there is no still final beat — the last motion runs straight into the hard cut.";
/** Stage 116 — the character / crowd reference photos are FRONTAL, standing, camera-facing full-body portraits;
 *  this directive stops Seedance from copying that pose. References fix ONLY identity / appearance — pose and
 *  orientation come from the scene's action, and the cast is never lined up frontally staring at the viewer. */
export const REFERENCE_APPEARANCE_ONLY_LINE =
  "REFERENCES DEFINE APPEARANCE ONLY, NOT POSE OR CAMERA ORIENTATION: the attached reference images fix each person's IDENTITY and LOOK only — face, hair, skin, build, wardrobe and colours. They do NOT dictate pose, body orientation or gaze. IGNORE the frontal, standing, camera-facing pose of the reference photos entirely. Every character's pose and which way they face come from THIS scene's action: they may be shown in three-quarter, in profile, from behind, at an angle, seated, bent over, crouched, mid-move, partly out of frame, or deep in the background, busy with what they are doing. Do NOT line the characters up frontally in a row facing the viewer, and do NOT have them all look at the camera — distribute them through the depth of the frame (foreground / mid-ground / background) with natural body angles driven by the action. A face turns toward the camera ONLY when the beat truly requires it.";

/** Stage 118 — cast continuity across the cut: the group of people on screen never silently swaps.
 *  Whoever is present at the END of the previous shot/scene is still present as the SAME identified
 *  characters when this shot opens; anyone who leaves is SHOWN leaving and anyone who arrives is SHOWN
 *  arriving — nobody vanishes or teleports between cuts. */
export const CAST_CONTINUITY_LINE =
  "CAST CONTINUITY ACROSS THE CUT: the people on screen carry over from the end of the previous shot — the SAME identified characters continue into this shot; do NOT swap the on-screen group for a different set of people between consecutive shots, and keep the same headcount and identities. If a character leaves, SHOW them leaving on screen (walking out of frame, stepping away, exiting the door); if a character enters, SHOW them entering. Nobody vanishes, is silently dropped, or is replaced between cuts unless this shot's action explicitly motivates them entering or leaving on screen. In a re-angled view the people from the source frame are all preserved in the new angle — same individuals, only the camera moves.";

/** Stage 119 — location continuity anchor: the attached wide + layout master plates are the FIXED, authoritative
 *  truth of this environment. Across every shot of the location the fixed set objects stay identical — same
 *  bench/seating, same floor, same columns/walls, fixtures and large props, same design, materials, colours and
 *  placement as the plates and the previous shot. Only the camera angle and the characters' actions change. */
export const LOCATION_ANCHOR_LINE =
  "LOCATION IS CONSTANT (fixed environment): the attached wide and layout location plates define the FIXED environment of this place — treat them as the authoritative truth of the room. Across EVERY shot of this location the fixed objects are IDENTICAL: the SAME bench / seating, the SAME floor and its pattern, the SAME columns, walls, fixtures and large props, with the SAME design, materials, colours and placement as in the location plates and the previous shot. Do NOT swap furniture for a different model (e.g. do not turn a solid cast bench into a perforated one), do NOT restyle, resize, add or remove fixed set objects, and do NOT rearrange the layout between shots. Do NOT change or invent the background architecture: the walls, columns, doorways and openings match the wide/layout plates exactly in every shot — where the plates show a solid wall it stays a solid wall, NEVER replaced by columns, pillars, a passage, an archway, an opening, a doorway, a window, an escalator or open space, and NEVER add columns, pillars, arches, openings or any structure that is not present in the location plates. When a shot reveals a previously unseen surface, reconstruct it strictly from the plates instead of inventing new architecture. The attached elevated LAYOUT plate is the FLOOR-PLAN of this location: every fixed object stands in the SAME place and flush against the SAME wall as in the layout plate, and any furniture set against a wall keeps its back/rear side flush against that wall in EVERY shot — it never drifts off the wall to leave a gap, columns or open space behind it. The camera is free to move to any new angle, height or shot scale, but the room's LAYOUT (what sits where, and against which wall) stays exactly as in the layout plate. Only the camera angle and the characters' actions change; the room itself is constant.";

/** Stage 122 — when this scene has a pre-generated REGION PLATE attached, it is the PRIMARY geometry/background
 *  authority for the room, above the wide/layout masters and above the re-angle frame. The plate already frames
 *  THIS part of the constant location; the clip reproduces that environment exactly while its camera stays free. */
export const REGION_PLATE_ANCHOR_LINE =
  "REGION PLATE IS THE ENVIRONMENT AUTHORITY (this part of the location): the attached region plate is a controlled re-frame of the master plates onto the exact part of the location where this scene happens — treat it as the PRIMARY, authoritative truth of the background and geometry for this shot, above every other reference. Reproduce its walls, floor, columns, fixtures and fixed furniture EXACTLY — same objects at the same places, wall-adjacent furniture flush against the same wall, same architecture, materials, colours and lighting. Do NOT add, remove, resize, restyle or rearrange fixed set objects and do NOT change or invent architecture: where the plate shows a solid wall it stays a solid wall, NEVER replaced by columns, pillars, a passage, an archway, an opening, a doorway, a window, an escalator or open space, and NEVER add any structure not present in the plate. The region plate fixes the ENVIRONMENT ONLY — it does NOT impose any character's pose, and it is NOT the camera angle of this shot: the camera is free to move to any angle, height or shot scale within this same environment, and the people's poses come from this scene's action. When a re-angle opening frame is also attached, take the PEOPLE and MOTION from it but take the BACKGROUND, LAYOUT and GEOMETRY from this region plate.";

/** Stage 120 — eyelines connect in dialogue: a character who addresses another looks AT that listener,
 *  and the listener looks back, achieved by turning the head/eyes (natural three-quarter / profile / over-the-
 *  shoulder angles) — NEVER by squaring up frontally to the camera and NEVER as a static face-to-face line-up.
 *  Complements Stage 116 (references fix appearance, not pose/orientation; nobody stares at the viewer). */
export const GAZE_AT_LISTENER_LINE =
  "EYELINES CONNECT (look at whoever is addressed): when a character speaks to another character, their head and eyes are turned toward that listener — the speaker looks AT the person they address, and the listener, reacting, looks back at the speaker, unless the beat gives a clear reason to look elsewhere (checking a threat, glancing away, deliberately not meeting the other's eyes). Achieve this by turning the head and eyes toward the other person, NOT by squaring up frontally to the camera: keep natural three-quarter, profile or over-the-shoulder angles, and NEVER have anyone turn to face the viewer to do it. Do NOT pose the pair in a static, symmetrical face-to-face stand-off either — they keep moving, shifting weight and acting while their gaze stays connected to whoever they are talking to.";

/** Stage 120 — the action is not reset on the seam: through the HARD CUT (no fade/dissolve) the motion that
 *  was underway keeps going from the same phase and direction, same items in the same hands, without pausing,
 *  freezing, restarting from the beginning or skipping part of the action. Dialogue may carry on (114/115);
 *  the transition stays a hard cut (117). Applied on continuing shots (continuous seam / re-angle). */
export const ACTION_CONTINUES_ACROSS_CUT_LINE =
  "ACTION CONTINUES ACROSS THE CUT (no reset on the seam): the cut to the new camera is a HARD CUT with no fade, dissolve or crossfade, and it does NOT interrupt the action. Whatever movement was underway at the end of the previous shot continues from the SAME motion phase and in the SAME direction — a swing keeps swinging, a step keeps going, a fall keeps falling — with the same items in the same hands and the same momentum. Do NOT restart the action from its beginning, do NOT pause, freeze or reset to a neutral standing pose on frame 1, and do NOT skip past part of the action across the cut: the motion picks up exactly where it left off while only the camera jumps to a new angle. Dialogue may carry straight on through the cut; the transition itself is always a hard cut, never a fade.";

/** Stage 126 — table/surface props are immutable set dressing: the small objects resting on tables, counters,
 *  desks and shelves of this location stay the SAME items in the SAME spots across every shot, never
 *  re-invented per scene, changing only when this scene's action moves them on screen. Fires whenever the
 *  shot has a location anchor (master plates or a region plate), i.e. exactly when the environment is fixed. */
export const SURFACE_PROPS_IMMUTABLE_LINE =
  "TABLE/SURFACE PROPS ARE IMMUTABLE (same objects on every surface in every shot): the small objects resting on this location's tables, counters, desks and shelves are FIXED set dressing — the SAME items in the SAME spots in every shot here (a mug, glass, bottle, plate, bowl, book, stack of papers, phone, lamp or utensil stays put, same quantity, colour and shape). Do NOT add, remove, swap, restyle, resize, recolour or rearrange anything sitting on a surface between shots, and do NOT re-invent what is on a table from scratch each scene. A surface object changes ONLY when this scene's action shows it changing on screen (a character picks it up, sets it down or moves it). The camera is free to frame these surfaces from any new angle, height or distance; the objects on them do not change.";

/** Stage 149 — compact direction tail for a single-speaker / no-second-party clip. Keeps the
 *  lip-sync + verbatim-line guarantee and the character-forward framing, and the static-camera-in-
 *  dialogue vs follow-walking rule (S133), WITHOUT the two-party eyeline / face-to-face staging rules
 *  (those only make sense with two conversing characters). */
export const SINGLE_SPEAKER_DIRECTION =
  "PACE: one continuous beat built AROUND the single speaking character — medium / medium-close / over-the-shoulder framing with the character large in frame and the location only a soft background; a face close-up is allowed and encouraged on an emotional beat. The character's lips move in exact sync with the spoken English line, which is delivered VERBATIM; no second party speaks and nobody is posed face-to-face. The camera holds steady while the character talks — it does not drift, orbit or push in on its own — but it FOLLOWS the character if they walk, and it stays free to pick any angle, height or shot scale on the cut.";

/** Stage 150 — proxemics for a SHORT line delivered IN PASSING. When a moving/passing character has a
 *  single short line, real people do NOT close to point-blank range or stop face-to-face just to say it —
 *  they keep walking, turn only head and shoulders, and call the line over the shoulder / after the other
 *  person. This conditional module (emitted only for the passing-short-line case — see isPassingShortLine)
 *  stops the model from staging an unnatural point-blank convergence with the listener frozen into a face-off. */
export const PASSING_SHORT_LINE_DIRECTION =
  "PROXEMICS (short line in passing): the speaking character does NOT close to point-blank range and does NOT stop to stand face-to-face just to deliver this short line. They keep moving / pass by at a natural conversational distance, turn only the head and shoulders toward the other person, and call the line out over the shoulder or after them as they go. The other character does NOT freeze into a face-off; do NOT force the two together into a point-blank convergence for the line.";

const oneLine = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim();

/* ====================================================================================== */
/*  Stage 149 — conditional / leaner emitted video-clip prompt helpers                     */
/* ====================================================================================== */

/**
 * Stage 149 — number of DISTINCT speaking characters in a dialogue block (by labelled speaker).
 * Two-party dialogue staging rules (EYELINES CONNECT, the "never two people face to face" tail) are
 * only emitted when this is ≥ 2; a single-speaker or unlabelled line does not pull them in.
 */
export function distinctSpeakerCount(dialogue: string | null | undefined): number {
  return new Set(
    parseDialogue(dialogue)
      .map(l => (l.speaker ?? "").toLowerCase().trim())
      .filter(Boolean),
  ).size;
}

/**
 * Stage 149 — interior vs exterior inference for the interior-only environment rules (LOCATION
 * ANCHOR / SURFACE PROPS / wall-constancy). There is no boolean schema flag, so:
 *   • an INT. slate in the location description ⇒ interior;
 *   • an EXT. slate ⇒ exterior;
 *   • otherwise fall back to `hasLocationPlates` — a plate-anchored location with no slate is treated
 *     as interior (preserves the Stage 119/122 behaviour for the existing plate-anchored scenes).
 */
export function isInteriorLocation(locationDesc: string | null | undefined, hasLocationPlates: boolean): boolean {
  const d = (locationDesc ?? "").trim();
  if (/(^|\b)INT\b\.?/i.test(d)) return true;
  if (/(^|\b)EXT\b\.?/i.test(d)) return false;
  return hasLocationPlates;
}

/** Stage 149 — blocking / fight keywords that mark a confrontation beat outside an "action" scene. */
const CONFRONTATION_RE =
  /\b(fight|fights|fighting|fought|punch|punche[ds]|strike[sd]?|struck|shove[sd]?|grab(?:s|bed|bing)?|weapon|knife|blade|gun|sword|attack(?:s|ed|ing)?|lunge[sd]?|slap[s]?|slapped|choke[sd]?|strangl|struggl|brawl|confront(?:s|ed|ation)?|threaten(?:s|ed)?|kick(?:s|ed|ing)?|clash(?:es|ed)?|stab(?:s|bed)?|throttl|wrestl|beat(?:s|ing)?\s+(?:him|her|them|up))\b/i;

/**
 * Stage 149 — is this a confrontation / fight scene? The CONFRONTATION staging sentence is only
 * emitted for these; ordinary dialogue scenes omit it. True for an "action" scene, or when the
 * scene's action / video-prompt text carries physical-confrontation keywords.
 */
export function isConfrontation(scene: { sceneKind?: string | null; videoPrompt?: string | null; action?: string | null }): boolean {
  if ((scene.sceneKind ?? "") === "action") return true;
  return CONFRONTATION_RE.test(`${scene.action ?? ""}\n${scene.videoPrompt ?? ""}`);
}

/** Stage 150 — a "short" line is a single spoken line at or under this many words. */
export const SHORT_LINE_MAX_WORDS = 7;

/** Stage 150 — travel / walking evidence: the speaker is moving THROUGH the shot, not stopping to talk. */
const PASSING_MOTION_RE =
  /\b(walk(?:s|ing)?|pass(?:es|ing)?\s+by|passes|passing|strides?|striding|cross(?:es|ing)?|moves?\s+past|move[sd]?\s+past|breez(?:es|ing)?\s+past|head(?:s|ing)?\s+past|brush(?:es|ing)?\s+past|keeps?\s+(?:moving|walking)|without\s+stopping|on\s+(?:his|her|their)\s+way|walk(?:s|ing)?\s+away)\b/i;

/** Stage 150 — stop-and-talk evidence: overrides the passing heuristic (it's a stationary beat after all). */
const STOP_TO_TALK_RE =
  /\b(stops?|halts?|stands?\s+still|sits?|sits\s+down|freezes?)\b/i;

/**
 * Stage 150 — is this beat a SHORT line delivered IN PASSING (Scene-3 proxemics bug)? Conservative
 * heuristic: exactly ONE labelled spoken line whose text is 1..SHORT_LINE_MAX_WORDS words, AND the
 * action / video-prompt carries travel/walking evidence (PASSING_MOTION_RE) while NOT being an explicit
 * stop-and-talk beat (STOP_TO_TALK_RE). Only then do we emit PASSING_SHORT_LINE_DIRECTION so the speaker
 * calls the line over the shoulder instead of closing to point-blank range. Normal stationary dialogue,
 * long lines, and multi-line exchanges all return false and are unaffected.
 */
export function isPassingShortLine(input: { dialogue?: string | null; action?: string | null; videoPrompt?: string | null }): boolean {
  const lines = parseDialogue(input.dialogue);
  if (lines.length !== 1) return false;
  const words = (lines[0]?.text ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > SHORT_LINE_MAX_WORDS) return false;
  const motionText = `${input.action ?? ""}\n${input.videoPrompt ?? ""}`;
  if (STOP_TO_TALK_RE.test(motionText)) return false;
  return PASSING_MOTION_RE.test(motionText);
}

/**
 * Stage 149 — drop any "NOT IN FRAME: <names>" inventory clause from a state description before it is
 * emitted. The screenwriter writes an "IN FRAME … NOT IN FRAME …" inventory into start/end states
 * (FRAME_STATE_ASPECTS); naming the ABSENT characters in the video prompt tends to summon them, so the
 * emitted OPENING/END STATE keeps only the positive "IN FRAME" listing (plus the numeric PEOPLE IN
 * FRAME counter). The stored state is untouched — this strips ONLY the emitted copy.
 */
export function stripNotInFrame(text: string | null | undefined): string {
  let s = text ?? "";
  if (!s) return s;
  // "(b) NOT IN FRAME: …" (optional parenthesised marker) or bare "NOT IN FRAME: …" up to the next
  // sentence end or newline.
  s = s.replace(/\s*(?:\([a-z]\)\s*)?NOT\s+IN\s+FRAME\s*:[^\n.]*\.?/gi, " ");
  return s.replace(/ {2,}/g, " ").replace(/\s+([.,;])/g, "$1").trim();
}

/**
 * Stage 149 — neutralise the inter-shot [TRANSITION] tag. The scripted [TRANSITION] used to DESCRIBE
 * the NEXT shot's content, which the model would start rendering inside THIS clip. Replace its content
 * with a fixed neutral hard-cut instruction while keeping the `[TRANSITION]` token (the 9-tag order is
 * relied on elsewhere). Internal seam metadata (openingState/endState/continuesFrom) is untouched.
 */
export const NEUTRAL_TRANSITION_LINE =
  "[TRANSITION]: hard cut to the next shot — no fade, no dissolve. Do NOT show, begin or foreshadow the next shot's action, location or dialogue inside this clip; this clip ends on its own final beat.";
export function neutralizeTransition(prompt: string): string {
  return (prompt ?? "").replace(/\[TRANSITION\]:?[^\n]*/i, NEUTRAL_TRANSITION_LINE);
}

/**
 * The state the scene must open from (Stage 40/41), in priority order:
 *  1. the previous scene's ACTUAL last-frame description (chain mode) — unless this scene breaks the
 *     sequence (location-change / new-sequence);
 *  2. this scene's own scripted `startState` (written by the screenwriter for every scene, incl. scene 1);
 *  3. legacy fallback for scenes scripted before Stage 41: the previous scene's scripted `endState`.
 * null when nothing applies.
 */
export function resolveOpeningState(scene: { continuesFrom?: string | null; startState?: string | null }, previous: ScenePromptPrevious | null | undefined): string | null {
  const continues = !!previous && !breaksSequence(scene.continuesFrom);
  const actual = continues ? oneLine(previous!.endStateActual) : "";
  if (actual) return actual;
  const own = oneLine(scene.startState);
  if (own) return own;
  if (!continues) return null;
  return oneLine(previous!.endState) || null;
}

/** Stage 41 — the scene's own scripted end state for the END STATE block (null when absent). */
export function resolveEndState(scene: { endState?: string | null }): string | null {
  return oneLine(scene.endState) || null;
}

export interface BuildScenePromptInput {
  scene: ScenePromptScene;
  /** Speaking / visible scene characters (from SceneCharacter → Character). */
  characters: ScenePromptCharacterLink[];
  /** The episode's location, or null when it has no styled reference angles. */
  location: ScenePromptLocation | null;
  /** The adjacent previous scene (accepted for API compatibility; Stage 38 no longer chains its frame). */
  previous: ScenePromptPrevious | null;
  /** Legacy video model id / worker provider; always normalized to Seedance 2.5. */
  provider?: string | null;
  /**
   * English dialogue to voice, already resolved by the caller (the worker passes the translated
   * text here). When omitted the stored `dialogueEn` (else `dialogue`) is used verbatim — this is
   * what the preview does, so it never triggers a translation.
   */
  resolvedDialogueEn?: string | null;
  /**
   * Stage 40 — when the scene has NO styled character / location / crowd references, submit it
   * text-only instead of generating a new-scene Flux still (test episodes, reference-less projects).
   */
  textOnlyWhenNoReferences?: boolean;
  /**
   * Stage 54 — the episode's PROP REGISTRY (variant B). The full list of the episode's key recurring
   * props with their canonical English descriptions; the builder substitutes the description of every
   * prop whose name appears in THIS scene VERBATIM into the «CLOTHING & PROPS» section, so a prop
   * (e.g. a blue tin) looks identical in every scene. Empty / omitted = no shared props.
   */
  props?: PropRegistryEntry[];
  /**
   * Stage 72 — the episode's scene-generation order. The previous scene's LAST FRAME is sent as a
   * continuity reference ONLY in "chain" mode (scenes render one after another, so the frame exists).
   * Omitted / "parallel" → no previous_frame reference (all scenes render simultaneously).
   */
  chainMode?: "parallel" | "chain" | null;
  reangleUrl?: string | null;
  /**
   * Stage 122 — the pre-generated REGION PLATE for this scene: an environment plate (Seedream edit of the master
   * layout) of the exact part of the location this scene happens in. When present it is sent as the PRIMARY
   * geometry/background reference (a non-droppable anchor, ahead of the master plates) so the environment no longer
   * depends on the fragile re-angle. It is NOT a keyframe and never a first frame; it imposes no pose and no camera.
   * Omitted / null → the scene falls back to the master wide/layout plates exactly as before (no auto-migration).
   */
  regionPlateUrl?: string | null;
  /** URLs forbidden from video, even if accidentally assigned to cast/location. */
  forbiddenReferenceUrls?: string[];
}

/**
 * Stage 36 removed the first-frame (`image`) path; Stage 38 removed the "previous_frame" reference
 * as well — only character / location / crowd references (or a fresh scene still) are ever sent.
 */
export type ScenePromptReferenceKind = "character_references" | "new_scene_reference" | "text_only";

/** One reference image as submitted to the provider (order preserved). */
export interface SceneReference {
  url: string;
  /** character | location | crowd | scene */
  kind: string;
  note: string;
}

export interface BuildScenePromptResult {
  /** The FINAL prompt submitted to Seedance (with the `[ImageN]` notes already appended). */
  prompt: string;
  /** The core prompt WITHOUT the `[ImageN]` notes (used by moderation auto-recovery). */
  basePrompt: string;
  /** The styled visual prompt (pre audio/pace), reused by the new-scene reference still. */
  visualPrompt: string;
  /** Normalized video model id. */
  model: VideoModelId;
  /** Provider model slug. */
  modelSlug: string;
  /** Which reference strategy the scene resolves to. */
  referenceKind: ScenePromptReferenceKind;
  /** true when the submitted text is the producer's manual override (Stage 31). */
  hasOverride: boolean;
  /** Stage 40 — the OPENING STATE text inserted before the visual prompt (null when none applies). */
  openingState: string | null;
  /** Stage 41 — the END STATE text inserted after OPENING STATE (null when the scene has no scripted end state). */
  endState: string | null;
  /** Reference descriptor persisted with the prediction (referencePredictionId is added later for new_scene_reference). */
  reference: Record<string, unknown>;
  /** Reference image URLs for character_references; empty for text_only and (until the worker generates it) new_scene_reference. */
  referenceImages: string[];
  /** Full ordered reference set with kinds/notes (empty until the worker fills it for new_scene_reference). */
  retryRefs: SceneReference[];
  /** Reduced reference set kept for diagnostics: individual characters + the wide location angle. */
  fallbackRefs: SceneReference[];
  /** Stage 62: the previous scene's id when its LAST FRAME is sent as a continuity reference (same-location continuation); null otherwise. */
  previousFrameSceneId: string | null;
  /** true when the worker must generate a fresh Flux still (no chain, no references). */
  newSceneReference: boolean;
  /** Flux text-to-image prompt for the new-scene reference still (only when newSceneReference). */
  referencePrompt?: string;
  /** The deterministic note appended for the new-scene reference (worker reuses it for retryRefs). */
  newSceneReferenceNote?: string;
  /** English dialogue actually used (empty for narration / no dialogue). */
  dialogue: string;
  /** true for an off-screen narration scene (b-roll under narration). */
  isNarration: boolean;
}

/**
 * Stage 27a: only strip the literal "slow motion" visual effect (a model artifact request that
 * warps the footage). Natural conversational pacing — unhurried delivery, the normal small pauses of
 * real speech and gentle camera moves — is intentionally KEPT.
 */
export function stripSlowDirections(prompt: string): string {
  return prompt
    .replace(/\b(in )?slow[- ]?motion\b/gi, "")
    .replace(/ {2,}/g, " ");
}

/**
 * Stage 54 — labels of the deterministic sections injected into every auto prompt (English, fixed).
 */
export const SCENE_SECTION = {
  referenceMap: "REFERENCE MAP",
  people: "PEOPLE IN FRAME",
  props: "CLOTHING & PROPS",
  set: "SET OBJECTS",
  negatives: "NEGATIVES",
} as const;

/** Stage 113 — at most this many set-inventory objects enter one video prompt (keeps the prompt compact). */
export const SET_OBJECTS_CAP = 8;

/**
 * Stage 113 — pick the location's set-inventory entries ("object — placement") that the scene text mentions
 * (case-insensitive: the whole object name or any of its words longer than 3 letters), in inventory order,
 * capped at SET_OBJECTS_CAP. Pure and deterministic. [] without an inventory or without matches.
 */
export function matchSetInventoryInText(setInventory: string | string[] | null | undefined, text: string | null | undefined, cap = SET_OBJECTS_CAP): string[] {
  const entries = (Array.isArray(setInventory) ? setInventory : (setInventory ?? "").split(/\r?\n/)).map(e => (e ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const t = (text ?? "").toLowerCase();
  if (!entries.length || !t.trim()) return [];
  const out: string[] = [];
  for (const e of entries) {
    const objectName = e.split(/\s+[—–-]\s+/)[0].toLowerCase().trim();
    if (!objectName) continue;
    const words = objectName.split(/[^a-z0-9']+/).filter(w => w.length > 3);
    const hit = t.includes(objectName) || words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`).test(t));
    if (hit) out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

/** Stage 113 — one compact line with the matched set objects and their fixed placement; "" when nothing matched. */
export function buildSetObjectsSection(matched: readonly string[]): string {
  if (!matched.length) return "";
  const base = `${SCENE_SECTION.set} (these are FIXED objects of the location, already in place at these exact positions — keep each one IDENTICAL in design, material, colour and placement across all shots, do not swap, restyle, resize, add, remove or rearrange them, and do not invent other furniture or props): ${matched.join("; ")}.`;
  // Stage 121 — entries whose placement is anchored to the architecture (against / flush / by a wall or in a
  // corner) carry that adjacency as a HARD spatial fact, so the object never drifts off the wall between camera
  // angles (the recurring "bench pulls away from the wall, columns appear behind it" drift).
  const wallAnchored = matched.filter(e =>
    /\b(against|flush|back(?:ed)?(?: to| against)?|along|by the|next to|in the corner)\b/i.test(e) && /\b(wall|corner)\b/i.test(e));
  if (!wallAnchored.length) return base;
  return `${base} WALL-ANCHORED PLACEMENT (keep each of these in the same place, against the same wall/corner, in every shot — its back/rear side stays flush against that wall, never drifting off to leave a gap, columns or open space behind it): ${wallAnchored.join("; ")}.`;
}

/**
 * Stage 54 — PEOPLE COUNTER, the main "how many are on screen" signal. Built from the ACTUAL scene
 * cast (SceneCharacter → Character): every non-crowd link is one named person; crowd-tier links are a
 * single background group, never named individually. Empty when the scene has no cast at all (b-roll),
 * so it never claims a false "0 people". Absent people are never listed.
 */
export function buildPeopleCounter(individuals: { name: string }[], hasCrowd: boolean): string {
  const names = individuals.map(c => (c.name ?? "").trim()).filter(Boolean);
  const n = names.length;
  if (n === 0 && !hasCrowd) return "";
  if (n === 0 && hasCrowd) return `${SCENE_SECTION.people}: only a background crowd (extras) is visible — no named individuals in frame.`;
  const head = n === 1
    ? `In frame exactly one person: ${names[0]}.`
    : `In frame exactly ${n} people: ${names.join(", ")}.`;
  const tail = hasCrowd
    ? " Plus a background crowd (extras) behind them; no other named individuals in frame."
    : " No other people in frame.";
  return `${SCENE_SECTION.people}: ${head}${tail}`;
}

/**
 * Stage 54 — compact REFERENCE MAP at the top: which attached image is who, so the model binds
 * identity before it reads the action. Characters come first and are exactly one image each (Stage 53),
 * so their Image indices are exact; the remaining images are the location angles (+ crowd), described
 * without over-committing to indices the cap could shift. Only "same place, same light" is asserted
 * about the location — its full description stays on the reference photo and is NEVER re-typed here.
 */
export function buildReferenceMap(individuals: { name: string }[], locationName: string | null, crowds: { name: string }[], leading?: string): string {
  // `leading` (optional) is a fixed first entry — every character index shifts by one.
  const offset = leading ? 1 : 0;
  const parts = individuals
    .map((c, i) => ({ nm: (c.name ?? "").trim(), i }))
    .filter(x => x.nm)
    .map(x => `Image${x.i + 1 + offset} = ${x.nm}`);
  if (leading) parts.unshift(leading);
  const tail: string[] = [];
  if (locationName) tail.push(`the location "${locationName}" from several angles (same place, same light — only the camera angle changes between shots; its elevated LAYOUT view is for object placement only, not a shot angle)`);
  crowds.forEach(c => { const nm = (c.name ?? "").trim(); if (nm) tail.push(`the crowd "${nm}" (extras)`); });
  if (!parts.length && !tail.length) return "";
  const head = parts.length ? `${parts.join(", ")} (each character's single full-body reference, in this order)` : "";
  const rest = tail.length ? `${head ? "; then " : "the remaining reference images are "}${tail.join(", then ")}` : "";
  return `${SCENE_SECTION.referenceMap}: ${head}${rest}.`;
}

/**
 * Stage 54 — the «CLOTHING & PROPS» section: the canonical descriptions of the props that appear in
 * this scene, substituted VERBATIM from the episode registry so the same object reads identically in
 * every scene. Empty when the scene shows none of the registry props.
 */
export function buildPropsSection(matched: readonly PropRegistryEntry[]): string {
  const parts = matched.map(p => (p.description ?? "").trim().replace(/\s*\n+\s*/g, " ")).filter(Boolean);
  if (!parts.length) return "";
  const joined = parts.join("; ");
  return `${SCENE_SECTION.props}: ${joined}${joined.endsWith(".") ? "" : "."}`;
}

/**
 * Stage 54 — the fixed NEGATIVES block appended to every auto prompt (never to a manual override).
 * The base list is identical on every clip; the music / lip-movement lines are added only for an
 * off-screen-narration scene (a voiceover with no on-camera speaker).
 */
export function buildNegatives(isNarration: boolean): string {
  const base = "no logos, no brand marks, no on-screen text, no subtitles or captions, no watermark, no split screen, no distorted anatomy; no other people in frame than described above";
  const extra = isNarration
    ? "; no background music over the narration; no character's lips move to the off-screen narration"
    : "";
  return `${SCENE_SECTION.negatives}: ${base}${extra}.`;
}

/** The single video anchor photo of a character: the styled full-body frame, else the legacy front portrait (Stage 53). */
export function characterAnchorUrl(c: ScenePromptCharacterLink): string {
  return isStyledAsset(c.imageFull) ? c.imageFull! : c.imageFront!;
}
/** Identity note attached to every character reference. Stage 116 — the note makes explicit that the
 *  frontal reference photo fixes LOOK only, never pose or camera orientation. */
export function characterReferenceNote(name: string): string {
  return `defines ${name}'s photorealistic appearance and identity ONLY (face, hair, skin, build, wardrobe) — NOT their pose or camera orientation. Take ${name}'s pose, body angle and gaze from THIS scene's action, not from the frontal reference photo; ${name} need not face the camera.`;
}
/** Note attached to every location angle reference. */
export function locationReferenceNote(locationName: string, angle: string): string {
  if (angle === "layout") return locationLayoutNote(locationName); // Stage 111 — the elevated layout view is a placement reference, never the shot's camera
  return `the location "${locationName}" — ${angle} angle. Same place, same time of day, same light and palette in every shot. Keep the camera inside this location and match this lighting exactly.`;
}

/**
 * Assemble the final Seedance prompt for a scene. Pure and deterministic: identical inputs always
 * produce the identical prompt, with no side effects and no real reference URLs in the text.
 */
export function buildScenePrompt(input: BuildScenePromptInput): BuildScenePromptResult {
  const { scene, characters, location, previous } = input;

  // Stage 46B-0: the [CHARACTER] line always reflects the CURRENT saved character rows, never the script-time copy.
  const visualPrompt = styledVisualPrompt(refreshCharacterLine(scene.videoPrompt ?? "", characters), characters.map(c => c.name));
  // Speech is ALWAYS English. `dialogueEn` holds the voiced lines; the worker translates legacy
  // non-English scenes once and passes the result via resolvedDialogueEn — the preview never does.
  const targetLanguage = "English";
  // Narration scenes carry an off-screen English narrator (b-roll under narration), NOT on-camera
  // dialogue — so they never go through the lip-sync/dialogue prompt path.
  const isNarration = scene.sceneKind === "narration" && !!(scene.voiceover ?? "").trim();
  const resolved = input.resolvedDialogueEn !== undefined && input.resolvedDialogueEn !== null
    ? input.resolvedDialogueEn
    : ((scene.dialogueEn ?? "").trim() || scene.dialogue || "");
  const dialogue = isNarration ? "" : resolved;

  // Stage 51/53 — reference SELECTION (single full-body anchor per character, all location angles,
  // crowds). Moved up in Stage 54 so the REFERENCE MAP / PEOPLE / PROPS sections can name what is sent.
  // The selection logic itself is UNCHANGED (see the strategy note further down).
  const anchorUrl = characterAnchorUrl;
  const styled = characters.filter(c => isStyledAsset(c.imageFull) || isStyledAsset(c.imageFront));
  const individualsAll = styled.filter(c => c.tier !== "CROWD");
  const crowds = styled.filter(c => c.tier === "CROWD");
  const mentionText = `${scene.videoPrompt ?? ""}\n${dialogue}\n${scene.voiceover ?? ""}`.toLowerCase();
  const isMentioned = (name: string) => {
    const n = name.trim().toLowerCase();
    return n.length > 0 && mentionText.includes(n);
  };
  const mentioned = individualsAll.filter(c => isMentioned(c.name));
  const unmentioned = individualsAll.filter(c => !isMentioned(c.name));
  const individuals = [...mentioned, ...unmentioned];
  const locationAngles = location ? [{ url: location.imageUrl, angle: "wide" }, { url: location.imageReverse, angle: "layout" }].filter((a): a is { url: string; angle: string } => !!a.url) : [];
  // Stage 44 — the extra angles of the same photographed place are references too (within the cap).
  const locationExtras: string[] = []; // Only the mandatory wide + layout plates.
  const effectiveLocation = locationAngles.length ? location : null;
  type Ref = SceneReference & { id: string };
  const characterRefs: Ref[] = individuals.map(c => ({ url: anchorUrl(c), kind: "character", id: c.characterId, note: characterReferenceNote(c.name) }));
  const locationRefs: Ref[] = [
    ...locationAngles.map(a => ({ url: a.url, angle: a.angle as string })),
    ...(effectiveLocation ? locationExtras.map((url, i) => ({ url, angle: locationExtraLabel(i) })) : []),
  ].map(a => ({ url: a.url, kind: "location" as const, id: effectiveLocation!.id, note: locationReferenceNote(effectiveLocation!.name, a.angle) }));
  // Stage 116 — in an ACTION scene a crowd that actually takes part in the fight (its name appears in the
  // scene's action / prompt / dialogue) is an ACTIVE OPPONENT in contact with the hero, NOT background: its
  // reference is promoted next to the leads (ahead of the location plates) and carries an opponent note, so the
  // model animates the creature / pack fighting the hero rather than treating it as a backdrop of extras.
  const isActionScene = !isNarration && scene.sceneKind === "action";
  const combatMentionText = `${scene.videoPrompt ?? ""}\n${dialogue}\n${scene.action ?? ""}`.toLowerCase();
  const isCombatCrowd = (c: ScenePromptCharacterLink) => {
    const n = c.name.trim().toLowerCase();
    return isActionScene && n.length > 0 && combatMentionText.includes(n);
  };
  const combatCrowds = crowds.filter(isCombatCrowd);
  const backgroundCrowds = crowds.filter(c => !isCombatCrowd(c));
  const crowdRefOf = (c: ScenePromptCharacterLink): Ref => ({
    url: anchorUrl(c),
    kind: "crowd",
    id: c.characterId,
    note: isCombatCrowd(c)
      ? `defines the look of "${c.name}" — an ACTIVE OPPONENT in this fight, in direct physical contact with the hero (advancing, lunging, swiping, grabbing, surrounding), NOT background extras: stage them attacking and colliding with the hero in the same frame.`
      : `defines the look of the group "${c.name}" (extras): who they are and how they are dressed.`,
  });
  const combatCrowdRefs: Ref[] = combatCrowds.map(crowdRefOf);
  const backgroundCrowdRefs: Ref[] = backgroundCrowds.map(crowdRefOf);
  // Stage 44 — the BASE photographed angles vs the extra angles are separated so the Stage 62 last-frame
  // ref can be prioritized above the extras (and above crowds) but not above the base angles.
  const baseLocationRefs = locationRefs.slice(0, locationAngles.length);
  const extraLocationRefs = locationRefs.slice(locationAngles.length);
  const forbidden = new Set([previous?.lastFrameUrl, ...(input.forbiddenReferenceUrls ?? [])].filter(Boolean));
  const reangleUrl = (input.reangleUrl ?? "").trim();
  if (reangleUrl && forbidden.has(reangleUrl)) throw new Error("The raw last frame cannot be a video reference.");
  const openingRefs: Ref[] = reangleUrl ? [{ url: reangleUrl, kind: "reangle", id: scene.id, note: REANGLE_REFERENCE_NOTE }] : [];
  // Stage 122 — the pre-generated REGION PLATE (when present) leads the location-geometry tier as the PRIMARY,
  // non-droppable environment/background authority for this scene's part of the room, ahead of the master plates.
  // It is not forbidden, not a duplicate of the re-angle frame, and never the first frame; it imposes no pose/camera.
  const regionPlateUrl = (input.regionPlateUrl ?? "").trim();
  const hasRegionPlate = !!regionPlateUrl && !forbidden.has(regionPlateUrl) && regionPlateUrl !== reangleUrl;
  const regionPlateRefs: Ref[] = hasRegionPlate && effectiveLocation
    ? [{ url: regionPlateUrl, kind: "location", id: effectiveLocation.id, note: REGION_PLATE_NOTE }]
    : [];
  // Stage 116 — combat crowds sit right after the leads (ahead of the location plates) so they are treated as
  // fighters and are never the first refs dropped at the cap; passive background crowds stay last as extras.
  // Stage 119 — reference priority tiers for the cap. The master location plates (wide + layout) join the
  // re-angle frame, the cast and the combat opponents as NON-DROPPABLE environment anchors, so every clip is
  // reconstructed from the SAME plates and the room never drifts. Only passive background-crowd extras (then
  // any extra location angles) are trimmed to fit REFERENCE_IMAGE_CAP — instead of failing the whole build.
  // Stage 122 — the region plate (if any) leads the location tier, ahead of the master wide/layout plates, and is
  // itself non-droppable: it is the primary environment authority, the masters remain as backing geometry truth.
  const anchorRefs = [...openingRefs, ...characterRefs, ...combatCrowdRefs, ...regionPlateRefs, ...baseLocationRefs].filter(r => !forbidden.has(r.url));
  const droppableRefs = [...backgroundCrowdRefs, ...extraLocationRefs].filter(r => !forbidden.has(r.url));
  if (anchorRefs.length > REFERENCE_IMAGE_CAP) throw new Error("Too many required video references. Reduce the scene cast.");
  const room = Math.max(0, REFERENCE_IMAGE_CAP - anchorRefs.length);
  const ordered = [...anchorRefs, ...droppableRefs.slice(0, room)];
  const fallbackRefs: SceneReference[] = ordered.map(({ url, kind, note }) => ({ url, kind, note }));

  // Stage 54 — deterministic sectioned signals injected into the auto prompt (see helpers above):
  //  • REFERENCE MAP  — which attached image is who (identity binding before the action);
  //  • PEOPLE IN FRAME — the exact people counter from the ACTUAL cast (main "how many" signal);
  //  • CLOTHING & PROPS — the episode registry props shown in THIS scene, substituted VERBATIM;
  //  • NEGATIVES — the fixed do-not block (appended after the body).
  const skipReferences = false; // Legacy text-only switches cannot bypass the approved chain.
  const matchedProps = matchPropsInText(input.props ?? [], mentionText);
  const referenceMap = ""; // Generated from the ACTUAL ordered refs below, including overrides.
  const peopleCounter = buildPeopleCounter(characters.filter(c => c.tier !== "CROWD"), characters.some(c => c.tier === "CROWD"));
  const propsSection = buildPropsSection(matchedProps);
  // Stage 113 — the location's set objects this scene uses (matched against the scene text), with placement.
  const setSection = buildSetObjectsSection(matchSetInventoryInText(location?.setInventory, `${mentionText}\n${scene.action ?? ""}`.toLowerCase()));
  const structureBlock = [referenceMap, peopleCounter, propsSection, setSection].filter(Boolean).join("\n");
  const negativesBlock = buildNegatives(isNarration);

  // Stage 38: an "action" scene (fight / duel / chase / physical struggle) gets the combat pace &
  // staging block INSTEAD of the talking-scene PACE_DIRECTION; a dialogue scene gets PACE_DIRECTION
  // plus the universal "confrontation is staged face to face" sentence. Narration is unchanged.
  const isAction = !isNarration && scene.sceneKind === "action";
  // Stage 149 — modular direction tail. The full two-party dialogue staging (PACE_DIRECTION with its
  // eyeline / framing / performance rules) is emitted only when 2+ DISTINCT speakers actually converse;
  // a single-speaker / soliloquy clip gets the compact SINGLE_SPEAKER_DIRECTION instead. The
  // CONFRONTATION staging sentence is added only for a confrontation / fight beat, never on calm talk.
  const speakerCount = distinctSpeakerCount(dialogue);
  const twoParty = speakerCount >= 2;
  const confront = !isNarration && isConfrontation(scene);
  const interior = isInteriorLocation(scene.locationDesc, locationAngles.length > 0);
  // Stage 150 — proxemics for a SHORT line delivered in passing: when a moving/passing character has a
  // single short line, emit PASSING_SHORT_LINE_DIRECTION so they call it over the shoulder instead of
  // closing to point-blank range and freezing the other person into a face-off (Scene-3 bug). Conservative:
  // normal stationary dialogue, long lines and multi-line exchanges are unaffected.
  const passingLine = !isNarration && isPassingShortLine({ dialogue, action: scene.action, videoPrompt: scene.videoPrompt });
  const direction = isNarration
    ? PACE_DIRECTION
    : isAction
      ? ACTION_PACE_DIRECTION
      : twoParty
        ? (confront ? `${PACE_DIRECTION} ${CONFRONTATION_STAGING_SENTENCE}` : PACE_DIRECTION)
        : (confront ? `${SINGLE_SPEAKER_DIRECTION} ${CONFRONTATION_STAGING_SENTENCE}` : SINGLE_SPEAKER_DIRECTION);
  // Stage 40 — scripted / actual end-state hand-off: when this scene continues the previous one
  // (not a location-change / new-sequence), the previous scene's end state opens the prompt so the
  // model starts frame 1 exactly where the last clip ended. The previous frame IMAGE is still never sent.
  // Stage 41 — the scene's own scripted END STATE follows the OPENING STATE block so the model knows
  // both where frame 1 starts and where the last frame must end.
  const openingState = reangleUrl ? oneLine(previous?.endStateActual) || null : resolveOpeningState(scene, previous);
  const endState = resolveEndState(scene);
  // Stage 44 — match cut on action: on a continuous seam the opening WORLD is the previous shot's final
  // instant while the CAMERA is new; the directive line makes that explicit for the video model.
  const continuousSeam = !!previous && !breaksSequence(scene.continuesFrom) && !!openingState;
  const stateBlocks = [
    // Stage 149 — the emitted OPENING/END STATE keeps only the positive "IN FRAME" roster; the
    // screenwriter's "NOT IN FRAME: <names>" clause is stripped so the absent cast is never named
    // (naming them tends to summon them). The stored state (returned below) is untouched.
    openingState ? `${OPENING_STATE_PREFIX}${stripNotInFrame(openingState)}` : "",
    continuousSeam && !reangleUrl ? NEW_CAMERA_ON_CUT_LINE : "",
    endState ? `${END_STATE_PREFIX}${stripNotInFrame(endState)}` : "",
    // Stage 118 — enforce cast continuity whenever this shot continues from a previous one
    // (continuous seam) or is a re-angle of an existing frame: the on-screen group never silently swaps.
    continuousSeam || reangleUrl ? CAST_CONTINUITY_LINE : "",
    // Stage 120 — on a continuing shot the action is NOT reset on the seam: the motion carries on from the
    // same phase/direction through the hard cut (no fade), the dialogue may continue, only the camera jumps.
    continuousSeam || reangleUrl ? ACTION_CONTINUES_ACROSS_CUT_LINE : "",
    // Stage 126 — on a continuing shot the characters KEEP their screen sides (line of action / 180-degree rule):
    // the left/right arrangement is carried over from the previous shot's last frame (read from openingState),
    // and the axis rule forbids the camera from crossing the line so people swap sides — WITHOUT locking the
    // camera (any angle/height/scale stays allowed) and without breaking EYELINES CONNECT.
    continuousSeam || reangleUrl
      ? stagingContinuityBlock(openingState, characters.filter(c => c.tier !== "CROWD").map(c => c.name))
      : "",
    SPEECH_BEFORE_CUT_LINE,
    NO_FROZEN_PADDING_LINE,
    REFERENCE_APPEARANCE_ONLY_LINE,
    // Stage 120 — in a dialogue shot, eyelines connect: the speaker looks at whoever they address (head/eyes
    // turned to the listener, natural angles, never to camera, never a static face-to-face stand-off).
    // Stage 149 — EYELINES CONNECT is a two-party rule: only emit it when 2+ distinct speakers converse.
    twoParty ? GAZE_AT_LISTENER_LINE : "",
    // Stage 150 — proxemics for a short line in passing: the moving speaker calls the line over the
    // shoulder at a natural distance instead of closing to point-blank range and freezing the listener
    // into a face-off. Emitted ONLY for the passing-short-line case; stationary dialogue is unaffected.
    passingLine ? PASSING_SHORT_LINE_DIRECTION : "",
    // Stage 119/122 — whenever the shot has master location plates attached, anchor the environment so the
    // fixed set objects (bench, floor, columns, fixtures, large props) stay identical across every clip. When a
    // pre-generated REGION PLATE is also attached, it becomes the PRIMARY environment authority for this part of
    // the room (it already re-frames the master plates onto this region), so its stronger line REPLACES the master
    // anchor line here — this keeps the prompt from carrying two overlapping environment blocks.
    // Stage 149 — the wall / architecture / layout constancy anchor is an INTERIOR-only rule: emit it
    // only for interior locations (exteriors — streets, rooftops — have no fixed room to hold constant).
    interior && hasRegionPlate ? REGION_PLATE_ANCHOR_LINE : (interior && locationAngles.length ? LOCATION_ANCHOR_LINE : ""),
    // Stage 126 — whenever the environment is anchored (region plate or master plates), the small props resting
    // on tables/counters/desks/shelves are immutable set dressing: the same objects in the same spots in every
    // shot, re-invented never, changing only when the on-screen action moves them. Carried between scenes of the
    // same location because the location's fixed inventory is identical in every scene there.
    // Stage 149 — TABLE/SURFACE props constancy is likewise interior-only.
    interior && (hasRegionPlate || locationAngles.length) ? SURFACE_PROPS_IMMUTABLE_LINE : "",
  ].filter(Boolean);
  // Stage 54 — the deterministic structure block (reference map + people counter + clothing&props)
  // sits AFTER the state blocks and BEFORE the reused 9-tag body, so the prompt still opens with the
  // OPENING/END STATE prefixes (Stage 40/41) and the body still begins with "\n\n[SHOT TYPE]".
  const statesJoined = stateBlocks.length ? stateBlocks.join("\n") : "";
  const preBody = [statesJoined, structureBlock].filter(Boolean).join("\n\n");
  const visualWithOpening = preBody
    ? `${preBody}\n\n${stripSlowDirections(visualPrompt)}`
    : stripSlowDirections(visualPrompt);
  // Sanitize visual descriptions BEFORE adding speech: never rewrite scripted dialogue / narration.
  let prompt = isNarration
    ? `${buildNarrationAudioPrompt(visualWithOpening, scene.voiceover)}\n\n${direction}`
    : `${buildNativeAudioPrompt(visualWithOpening, dialogue, characters.map(c => ({ name: c.name })), targetLanguage, { action: isAction })}\n\n${direction}`;
  // Stage 32: the assembled prompt is submitted VERBATIM — no moderation softening. The season
  // script now writes the real physical/dramatic action on purpose, so auto-softening here would
  // undo it. If the provider rejects an individual shot (E005) the job fails fast and the producer
  // fixes that scene by hand via a manual per-scene override (Stage 30/31).
  // A manual override replaces the auto-assembled TEXT verbatim and suppresses the `[ImageN]` notes
  // appended below; the reference image set is still computed (and sent) as usual either way.
  const override = (scene.promptOverride ?? "").trim();
  const hasOverride = override.length > 0;
  if (hasOverride) {
    // Stage 46B-0: the producer's text is kept verbatim, except a [CHARACTER] line it still carries —
    // that one is rebuilt from the live character rows too (no line → nothing is added). A manual
    // override is authored end-to-end, so Stage 54's fixed NEGATIVES block is NOT appended to it.
    prompt = buildNativeAudioPrompt(stripReferenceList(refreshCharacterLine(override, characters, false)).replace(/^REFERENCE MAP:.*$/gm, ""), dialogue, characters.map(c => ({ name: c.name })), targetLanguage);
  } else {
    // Stage 54 — the fixed do-not block closes the auto-assembled prompt (after the AUDIO TRACK and the
    // pace direction), covering logos/watermarks/subtitles/extra people plus the narration-only bits.
    prompt = `${prompt}\n\n${negativesBlock}`;
  }
  let basePrompt = prompt;

  const model = normalizeVideoModel(input.provider);
  const modelSlug = videoModelSlug(model);

  let referenceImages: string[] = [];
  let retryRefs: SceneReference[] = [];
  let reference: Record<string, unknown>;
  let referenceKind: ScenePromptReferenceKind;
  let newSceneReference = false;
  let referencePrompt: string | undefined;
  let newSceneReferenceNote: string | undefined;
  // Stage 62: set to the previous scene's id when its last frame is sent as a continuity reference; else null.
  let previousFrameSceneId: string | null = null;

  if (ordered.length) {
    const refs = ordered;
    referenceImages = refs.map(r => r.url);
    retryRefs = refs.map(({ url, kind, note }) => ({ url, kind, note }));
    previousFrameSceneId = reangleUrl ? previous?.id ?? null : null;
    reference = { mode: "character_references", kinds: refs.map(r => r.kind),
      characterIds: refs.filter(r => r.kind === "character" || r.kind === "crowd").map(r => r.id),
      locationId: refs.some(r => r.kind === "location") ? location?.id : null,
      previousFrameSceneId };
    referenceKind = "character_references";
    prompt += "\nREFERENCE MAP:\n" + refs.map((r, i) => `[Image${i + 1}] ${r.note}`).join("\n");
  } else {
    reference = { mode: "text_only", sceneId: scene.id, reason: "no_references" };
    referenceKind = "text_only";
  }

  // Stage 149 — final emitted-copy pass: guard [TRANSITION] against rendering next-shot
  // content (neutral hard-cut note) and force ASCII English (romanize any residual Cyrillic,
  // incl. REFERENCE MAP name echoes). Idempotent; English dialogue carries no Cyrillic so the
  // verbatim spoken lines are preserved untouched.
  const finalizeEmitted = (p: string) => transliterateCyrillic(neutralizeTransition(p));
  prompt = finalizeEmitted(prompt);
  basePrompt = finalizeEmitted(basePrompt);

  return {
    prompt,
    basePrompt,
    visualPrompt,
    model,
    modelSlug,
    referenceKind,
    hasOverride,
    openingState,
    endState,
    reference,
    referenceImages,
    retryRefs,
    fallbackRefs,
    previousFrameSceneId,
    newSceneReference,
    referencePrompt,
    newSceneReferenceNote,
    dialogue,
    isNarration,
  };
}

/**
 * Stage 104 — remove the `[ImageN] ...` reference legend (and the LOCATION_INSIDE_NOTE line that follows
 * it) from an assembled scene prompt. Stage 111: the i2v submission is gone (every scene is text-to-video
 * with references again), so this is a plain utility kept for tools/tests. Pure; every other line is kept verbatim.
 */
export function stripReferenceList(prompt: string): string {
  const lines = (prompt ?? "").split("\n");
  const kept = lines.filter(line => {
    const t = line.trim();
    if (/^\[Image\d+\]/i.test(t)) return false;
    if (/keyframe|last_image|^CONTINUE FROM \[Image|^REFERENCE MAP:/i.test(t)) return false;
    if (t === LOCATION_INSIDE_NOTE.trim()) return false;
    return true;
  });
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
