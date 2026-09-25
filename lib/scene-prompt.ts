/**
 * Shared, PURE prompt-building primitives for the video pipeline (no network, no LLM, no DB):
 * scene/character/location typing, reference caps and notes, speaker/interior/confrontation
 * heuristics, opening/end-state resolution, prop and reference-map sections and negatives.
 *
 * Stage 167 — the whole-scene prompt assembler has been removed together with the legacy scene
 * generation path; these helpers are now consumed by the SHOT pipeline (lib/prompts/shot.ts,
 * lib/keyframe.ts, lib/storyboard-prompt.ts) and the prompt-seam utilities.
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
  "Camera stays inside this location across the whole shot; lighting, weather, time of day and palette identical to the location references. Only the camera angle changes between shots. These frames are the SAME real place photographed from different positions — the characters are INSIDE this space: floor under their feet, walls/objects beside and behind them, real depth in front and behind; frame them inside this space at the shot scale the scene calls for (a dialogue shot stays close on the people), never as figures placed in front of a picture of the place. They interact with its objects and surfaces; the cuts show the same location from different angles with real depth (foreground, characters, background) — never a flat backdrop.";
/** @deprecated alias kept for older imports — use REFERENCE_IMAGE_CAP. */
export const MAX_REFERENCE_IMAGES = REFERENCE_IMAGE_CAP;

/**
 * Stage 242 — the EDITABLE scene-prompt template (project-level). The default template string and the
 * pure render helper live in the import-light ./scene-prompt-template module so client components can
 * import them without pulling this whole module graph into the browser bundle; they are re-exported here
 * for existing server-side callers. buildScenePrompt() renders the NON-override final prompt from the
 * template instead of a hard-coded block structure.
 */
export { DEFAULT_SCENE_PROMPT_TEMPLATE, renderSceneTemplate } from "@/lib/scene-prompt-template";
import { DEFAULT_SCENE_PROMPT_TEMPLATE, renderSceneTemplate } from "@/lib/scene-prompt-template";
/** Stage 112: only a camera edit of the ACTUAL predecessor frame can lead video references. */
export const REANGLE_REFERENCE_NOTE = "the OPENING FRAME: the actual previous video's final instant already re-rendered from THIS shot's new camera. Match this camera/composition at frame 1; do not re-angle it again. Then immediately perform this scene's action and dialogue, without freezing.";
/** Stage 122 — the note attached to the pre-generated REGION PLATE reference: the authoritative environment /
 *  geometry for THIS scene's part of the location. It fixes background and layout ONLY (never poses or the shot's
 *  camera), and the camera stays free. This is what removes the environment's dependence on the fragile re-angle. */
export const REGION_PLATE_NOTE =
  "REGION PLATE — the authoritative ENVIRONMENT and GEOMETRY for THIS scene's part of the location (a controlled re-frame of the master plates onto this region). Reproduce its walls, floor, columns, fixtures and the fixed furniture EXACTLY as shown, at the same places, with any wall-adjacent furniture kept flush against its wall; match its architecture, materials, colours and lighting. Do NOT add, remove or rearrange furniture and do NOT replace walls with columns, pillars, openings or open space. This plate defines the BACKGROUND and LAYOUT ONLY — it does NOT dictate any character's pose, and it is NOT the camera angle of this shot: the camera is free to move anywhere within this same environment.";
/** Stage 123 — the note attached to the pre-generated SUB-LOCATION angle reference: the environment of the exact
 *  SPOT within the location where this scene happens (a controlled re-frame of the master plates onto that spot,
 *  reused across every scene at the same spot). It is a LOCATION VISUAL reference (background/layout only, never a
 *  pose or the shot's camera); when a region plate is also present that plate stays the primary geometry authority. */
export const SUB_LOCATION_REF_NOTE =
  "SUB-LOCATION REFERENCE — the ENVIRONMENT of the exact SPOT within the location where THIS scene happens (a controlled re-frame of the master plates onto that spot, shared by every scene set there). Keep the walls, floor, fixtures and fixed furniture EXACTLY as shown, at the same places, matching architecture, materials, colours and lighting; do NOT add, remove or rearrange anything and do NOT replace walls with columns, openings or open space. This defines the BACKGROUND and LAYOUT of this spot ONLY — it does NOT dictate any character's pose and it is NOT the camera angle of this shot: the camera is free to move within this same environment.";

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
  "LOCATION IS CONSTANT (fixed environment): the attached wide and layout location plates define the FIXED environment of this place — treat them as the authoritative truth of the room. Across EVERY shot of this location the fixed objects are IDENTICAL: the SAME bench / seating, the SAME floor and its pattern, the SAME columns, walls, fixtures and large props, with the SAME design, materials, colours and placement as in the location plates and the previous shot. Do NOT swap furniture for a different model (e.g. do not turn a solid cast bench into a perforated one), do NOT restyle, resize, add or remove fixed set objects, and do NOT rearrange the layout between shots. Do NOT change or invent the background architecture: the walls, columns, doorways and openings match the wide/layout plates exactly in every shot — where the plates show a solid wall it stays a solid wall, NEVER replaced by columns, pillars, a passage, an archway, an opening, a doorway, a window, an escalator or open space, and NEVER add columns, pillars, arches, openings or any structure that is not present in the location plates. When a shot reveals a previously unseen surface, reconstruct it strictly from the plates instead of inventing new architecture. The attached elevated LAYOUT plate is the FLOOR-PLAN of this location: every fixed object stands in the SAME place and flush against the SAME wall as in the layout plate, and any furniture set against a wall keeps its back/rear side flush against that wall in EVERY shot — it never drifts off the wall to leave a gap, columns or open space behind it. This rule does NOT set the shot scale, framing, angle or height — those come solely from the CAMERA AUTHORITY block; here only the room's LAYOUT (what sits where, and against which wall) stays exactly as in the layout plate. Only the camera and the characters' actions change; the room itself is constant.";

/** Stage 122 — when this scene has a pre-generated REGION PLATE attached, it is the PRIMARY geometry/background
 *  authority for the room, above the wide/layout masters and above the re-angle frame. The plate already frames
 *  THIS part of the constant location; the clip reproduces that environment exactly while its camera stays free. */
export const REGION_PLATE_ANCHOR_LINE =
  "REGION PLATE IS THE ENVIRONMENT AUTHORITY (this part of the location): the attached region plate is a controlled re-frame of the master plates onto the exact part of the location where this scene happens — treat it as the PRIMARY, authoritative truth of the background and geometry for this shot, above every other reference. Reproduce its walls, floor, columns, fixtures and fixed furniture EXACTLY — same objects at the same places, wall-adjacent furniture flush against the same wall, same architecture, materials, colours and lighting. Do NOT add, remove, resize, restyle or rearrange fixed set objects and do NOT change or invent architecture: where the plate shows a solid wall it stays a solid wall, NEVER replaced by columns, pillars, a passage, an archway, an opening, a doorway, a window, an escalator or open space, and NEVER add any structure not present in the plate. The region plate fixes the ENVIRONMENT ONLY — it does NOT impose any character's pose, and it is NOT the camera angle of this shot: the shot scale, framing, angle and height are set solely by the CAMERA AUTHORITY block within this same environment, and the people's poses come from this scene's action. When a re-angle opening frame is also attached, take the PEOPLE and MOTION from it but take the BACKGROUND, LAYOUT and GEOMETRY from this region plate.";

/** Stage 120 — eyelines connect in dialogue: a character who addresses another looks AT that listener,
 *  and the listener looks back, achieved by turning the head/eyes (natural three-quarter / profile / over-the-
 *  shoulder angles) — NEVER by squaring up frontally to the camera and NEVER as a static face-to-face line-up.
 *  Complements Stage 116 (references fix appearance, not pose/orientation; nobody stares at the viewer). */
export const GAZE_AT_LISTENER_LINE =
  "EYELINES CONNECT (look at whoever is addressed): when a character speaks to another character, their head and eyes are turned toward that listener — the speaker looks AT the person they address, and the listener, reacting, looks back at the speaker, unless the beat gives a clear reason to look elsewhere (checking a threat, glancing away, deliberately not meeting the other's eyes). Achieve this by turning the head and eyes toward the other person, NOT by squaring up frontally to the camera: keep natural three-quarter, profile or over-the-shoulder angles, and NEVER have anyone turn to face the viewer to do it. The character DELIVERING a line is turned to FACE the person they address — body and face oriented toward that listener so the speaker's face is clearly readable in frame while the line is spoken; a character NEVER delivers a line with their BACK to the person they are addressing or while turned away from them. An over-the-shoulder or from-behind CAMERA angle is fine, but the speaker still faces the listener, not away from them. Do NOT pose the pair in a static, symmetrical face-to-face stand-off either — they keep moving, shifting weight and acting while their gaze stays connected to whoever they are talking to.";

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

/** Stage 164 — universal no-wide-shot-while-speaking rule for a talking scene (any on-screen speaker). Emitted
 *  as a compact conditional tail module for every talking scene (not narration, not action). It makes the
 *  prohibition explicit: while any line is being spoken the shot is a DIALOGUE framing kept close on the people,
 *  never a wide / establishing / group / whole-space shot, and only two or three characters converse (no crowd). */
export const DIALOGUE_FRAMING_RULE =
  "DIALOGUE FRAMING (no wide shots while anyone speaks): whenever a character is speaking, this is a DIALOGUE shot — frame it as an over-the-shoulder, waist-up half-body, medium, medium-close or close-up on the speaker and the person addressed, with the characters large in the frame and the location only a soft background. Do NOT use a wide, establishing, full-length, high-angle, aerial, group or whole-space shot while any line is being spoken; keep the camera close to the people. The character delivering a line is turned to FACE the person they address, their face visible in frame — NEVER shot with their back to that listener or turned away from them while speaking. Only two or three characters are present and converse — never a crowd around the conversation.";

/** Fix 1 (single camera authority) — ONE block governs every camera decision. Emitted FIRST so the model
 *  reads it before any continuity / environment / staging rule. The environment and continuity rules keep
 *  saying the camera is "free" to take any angle/height/shot scale, which USED to read as several competing
 *  camera directives; this line subordinates all of them to the single PACE/CAMERA/FRAMING direction that
 *  closes the prompt (plus DIALOGUE FRAMING while anyone speaks). The match-cut engine is preserved: on a
 *  continuous seam the framing must still CHANGE across the cut — this line only settles WHO decides the
 *  actual shot scale/framing (the authority), so nothing contradicts it. */
export const CAMERA_AUTHORITY_LINE =
  "CAMERA AUTHORITY (single source of truth for framing): every camera decision — shot scale, framing, camera height, angle, lens and the cuts inside the clip — is governed by ONE block only: the PACE / CAMERA / FRAMING direction that closes this prompt, together with the DIALOGUE FRAMING rule whenever a character speaks. No other line in this prompt sets or overrides the shot scale or framing. Where a continuity, environment or staging rule below says the camera is 'free' to take any angle, height or shot scale, that means only that the rule does NOT constrain the camera — the actual choice always comes from this single CAMERA AUTHORITY. The match-cut requirement still holds: on a continuous seam the camera cuts to a NEW angle / height / shot scale, never the previous framing — that rule sets only that the framing must CHANGE across the cut, while WHICH new framing is chosen still follows this authority.";

/** Fix 2 (prop / object continuity across the cut) — objects were teleporting / disappearing between clips.
 *  Complements CAST_CONTINUITY_LINE (people) and SURFACE_PROPS_IMMUTABLE_LINE (fixed set dressing): this one
 *  covers HAND-HELD and moveable objects carrying over the seam. Emitted on a continuous seam / re-angle. */
export const PROP_CONTINUITY_LINE =
  "PROP & OBJECT CONTINUITY ACROSS THE CUT: every object and prop present at the end of the previous shot is still present when this shot opens — the SAME items, the same number, the same colour and condition, held by the SAME hands or resting on the SAME surface. Nothing a character was holding vanishes, is swapped for a different object, changes hands or teleports to a new spot across the cut, and no new object appears in a hand or on a surface unless this shot's action shows it being picked up, set down, handed over or brought in on screen. What was in the hand, on the table or on the floor at the previous shot's final instant is exactly there, unchanged, at this shot's first instant.";

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

/* ─── Restored: whole-scene prompt assembler (default scene generation path). Pure; shared by the
   video worker's scene path and the scene prompt preview. Reinstated from pre-Stage-167 history. ─── */

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
  /**
   * Stage 123 — the pre-generated SUB-LOCATION angle reference for this scene: an environment plate (Seedream edit
   * of the master plates) of the exact SPOT within the location this scene happens at (Scene.subLocation), reused
   * across every scene at that spot. When present it is sent as an additional non-droppable LOCATION VISUAL
   * reference, after the region plate (which stays the primary geometry authority) and ahead of the master plates.
   * It is NOT a keyframe and never a first frame; it imposes no pose and no camera. Skipped when it would duplicate
   * the region plate or re-angle frame. Omitted / null → the scene falls back to the region plate / master plates.
   */
  subLocationRefUrl?: string | null;
  /** URLs forbidden from video, even if accidentally assigned to cast/location. */
  forbiddenReferenceUrls?: string[];
  /**
   * Stage 242 — the project-level EDITABLE scene-prompt template. When set (non-empty after trim) it
   * REPLACES the default block structure for the NON-override prompt via {{SETTING}}/{{CHARACTERS}}/
   * {{ACTIONS}} token substitution. Omitted / null / blank → DEFAULT_SCENE_PROMPT_TEMPLATE (byte-for-byte
   * identical to the previous hard-coded output). The manual per-scene override path is unaffected.
   */
  template?: string | null;
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

  // ─── Stage 238 — NEW scene prompt template + strict reference order. ──────────────────────────
  // The scene prompt is now a fixed, self-contained English template. References ship in a strict
  // order that matches the "image N" numbers written into the prompt:
  //   image 1 = LOCATION (the room-layout plate),
  //   image 2 = START FRAME (the previous scene's last frame; OMITTED for the first scene → the
  //             numbering shifts up so characters begin at image 2),
  //   image 3..N = the scene's characters (appearance-only anchors).
  // No AUDIO / PACE / NEGATIVES / REFERENCE MAP blocks are appended — the template is complete.
  type NewRef = SceneReference & { id: string };
  const externalForbidden = new Set((input.forbiddenReferenceUrls ?? []).filter(Boolean) as string[]);
  const refs: NewRef[] = [];
  const settingLines: string[] = [];
  const characterLines: string[] = [];

  // image 1 — LOCATION (master wide plate; layout plate as fallback).
  const locationUrl = location ? ((location.imageUrl ?? "").trim() || (location.imageReverse ?? "").trim()) : "";
  if (locationUrl && !externalForbidden.has(locationUrl)) {
    refs.push({ url: locationUrl, kind: "location", id: location!.id, note: `LOCATION plate for "${location!.name}".` });
    settingLines.push(`image ${refs.length} — LOCATION: the only source of the room layout. Read strictly from it where every object is relative to the others. Do not add, remove or move anything.`);
  }

  // image 2 — START FRAME (the previous scene's last frame). Omitted for the first scene.
  const startFrameUrl = (previous?.lastFrameUrl ?? "").trim();
  const hasStartFrame = !!startFrameUrl && !externalForbidden.has(startFrameUrl);
  if (hasStartFrame) {
    refs.push({ url: startFrameUrl, kind: "scene", id: previous!.id, note: "START FRAME — the last frame of the previous scene." });
    settingLines.push(`image ${refs.length} — START FRAME: the last frame of the previous scene. Take from it ONLY the characters' positions in the location, their poses and the action they are in the middle of at the first frame. Do not take appearance, wardrobe, lighting or framing from it.`);
  }

  // image 3..N — characters (appearance only). Mentioned individuals first, then the rest, then crowds.
  const styled = characters.filter(c => isStyledAsset(c.imageFull) || isStyledAsset(c.imageFront));
  const individualsAll = styled.filter(c => c.tier !== "CROWD");
  const crowds = styled.filter(c => c.tier === "CROWD");
  const mentionText = `${scene.videoPrompt ?? ""}\n${dialogue}\n${scene.voiceover ?? ""}`.toLowerCase();
  const isMentioned = (name: string) => {
    const n = name.trim().toLowerCase();
    return n.length > 0 && mentionText.includes(n);
  };
  const orderedChars = [
    ...individualsAll.filter(c => isMentioned(c.name)),
    ...individualsAll.filter(c => !isMentioned(c.name)),
    ...crowds,
  ];
  for (const c of orderedChars) {
    if (refs.length >= REFERENCE_IMAGE_CAP) break;
    refs.push({ url: characterAnchorUrl(c), kind: c.tier === "CROWD" ? "crowd" : "character", id: c.characterId, note: characterReferenceNote(c.name) });
    characterLines.push(`image ${refs.length} — ${c.name}.`);
  }

  // ACTIONS body — the English descriptive action, drawn from the scene's English video-prompt tags
  // (blocking / action / gaze / non-verbal) with a plain-text fallback. Dialogue is appended as
  // NAME: "line"; a narration scene appends the off-screen narrator line instead.
  const extractTag = (vp: string, tag: string): string => {
    const re = new RegExp(`\\[${tag}\\]\\s*:?\\s*([\\s\\S]*?)(?=\\n?\\[[A-Z][A-Z /]*\\]|$)`, "i");
    const m = vp.match(re);
    return m ? m[1].replace(/\s+/g, " ").trim() : "";
  };
  const stripBracketLabels = (s: string) => s.replace(/\[[A-Z][A-Z /]*\]\s*:?/g, " ").replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  const rawVideoPrompt = refreshCharacterLine(scene.videoPrompt ?? "", characters);
  const actionParts = ["BLOCKING", "ACTION", "GAZE", "NON-VERBAL"].map(t => extractTag(rawVideoPrompt, t)).filter(Boolean);
  let actionsBody = actionParts.join(" ").trim();
  if (!actionsBody) actionsBody = stripBracketLabels(rawVideoPrompt);
  const dialogueLines = isNarration ? [] : parseDialogue(dialogue).map(l => `${(l.speaker ?? "Character").trim()}: "${l.text.trim()}"`);
  const narrationLine = isNarration ? `Off-screen narrator (voiceover): "${(scene.voiceover ?? "").trim()}"`.trim() : "";
  const actionsSection = [actionsBody, ...dialogueLines, narrationLine].filter(Boolean).join("\n");

  // Stage 242 — the NON-override text is rendered from the project's editable template (or the default,
  // which is byte-for-byte identical to the previous hard-coded structure). Empty Setting/Characters
  // blocks are dropped by renderSceneTemplate, so reference-less scenes match the old output exactly.
  const tpl = (input.template && input.template.trim()) ? input.template : DEFAULT_SCENE_PROMPT_TEMPLATE;
  const templatedPrompt = renderSceneTemplate(tpl, {
    SETTING: settingLines.join("\n"),
    CHARACTERS: characterLines.join("\n"),
    ACTIONS: actionsSection,
  });

  // Stage 40/41 — opening/end state kept for return-shape compatibility (not injected into the template).
  const openingState = resolveOpeningState(scene, previous);
  const endState = resolveEndState(scene);

  const model = normalizeVideoModel(input.provider);
  const modelSlug = videoModelSlug(model);

  // A manual per-scene override still REPLACES the whole prompt text verbatim (producer-authored),
  // while the reference set computed above is still sent unchanged.
  const override = (scene.promptOverride ?? "").trim();
  const hasOverride = override.length > 0;
  let prompt = hasOverride
    ? stripReferenceList(refreshCharacterLine(override, characters, false)).replace(/^REFERENCE MAP:.*$/gm, "").trim()
    : templatedPrompt;
  let basePrompt = prompt;

  const referenceImages: string[] = refs.map(r => r.url);
  const retryRefs: SceneReference[] = refs.map(({ url, kind, note }) => ({ url, kind, note }));
  const fallbackRefs: SceneReference[] = retryRefs;
  const previousFrameSceneId: string | null = hasStartFrame ? (previous?.id ?? null) : null;
  const newSceneReference = false;
  const referencePrompt: string | undefined = undefined;
  const newSceneReferenceNote: string | undefined = undefined;
  const referenceKind: ScenePromptReferenceKind = refs.length ? "character_references" : "text_only";
  const reference: Record<string, unknown> = refs.length
    ? {
        mode: "character_references",
        kinds: refs.map(r => r.kind),
        characterIds: refs.filter(r => r.kind === "character" || r.kind === "crowd").map(r => r.id),
        locationId: refs.some(r => r.kind === "location") ? location?.id ?? null : null,
        startFrameSceneId: previousFrameSceneId,
        previousFrameSceneId,
      }
    : { mode: "text_only", sceneId: scene.id, reason: "no_references" };

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
