/**
 * Stage 99 — per-scene readable "Scene Script" assembly (pure, DB-free, unit-tested).
 *
 * Turns a scene's stored fields into a clean English screenplay page. CORE REQUIREMENT:
 * each scene's script OPENS exactly where the previous scene ENDED. For a continuous seam
 * (continuesFrom is NOT location-change / new-sequence) the opening block is the PREVIOUS scene's
 * ending — endStateActual (the chain-mode real last frame) when present, otherwise endState. For
 * scene 1 or a sequence break the scene opens on its OWN startState as a fresh opening.
 *
 * This does NOT weaken the standing rule that "the passed frame is the STARTING STATE only; the
 * camera changes angle independently and does not move characters back into frame" — the opening
 * block describes the same WORLD instant, and the script says the camera simply re-frames it.
 *
 * Read-only: no ids, no secrets, no JSON — just the human-readable script text.
 */
import { isRefusal } from "@/lib/frame-state";
import { stripPreviousCameraLine } from "@/lib/prompt-seam";

// Mirror of lib/scene-prompt.ts SEQUENCE_BREAK_LINKS, kept local to avoid importing the protected file
// (and any circular import). Same values as season.ts' SEAM_BREAK_LINKS.
const SEQUENCE_BREAK_LINKS = ["location-change", "new-sequence"] as const;

/** True when this scene continues the previous scene's world (i.e. NOT a location change / new sequence). */
export function isContinuousSeam(continuesFrom?: string | null): boolean {
  const k = (continuesFrom ?? "").trim().toLowerCase();
  return !!k && !(SEQUENCE_BREAK_LINKS as readonly string[]).includes(k);
}

/** Every scene field the reader script is assembled from (all already stored on the Scene row). */
export interface SceneScriptFields {
  number: number;
  sceneKind?: string | null;
  durationSec?: number | null;
  continuesFrom?: string | null;
  locationDesc?: string | null;
  presence?: string | null;
  entrances?: string | null;
  action?: string | null;
  dialogue?: string | null;
  dialogueEn?: string | null;
  voiceover?: string | null;
  voiceoverLocal?: string | null;
  startState?: string | null;
  endState?: string | null;
  endStateActual?: string | null;
  characters?: string[] | null;
}

/** The minimal ending info of the immediately-preceding scene needed for the opening hand-off. */
export interface PreviousSceneEnding {
  number: number;
  endState?: string | null;
  endStateActual?: string | null;
}

const clean = (s?: string | null): string => (s ?? "").toString().trim();

/**
 * Stage 102 — the vision description of the real last frame, ready for the script: a refusal-looking
 * answer ("I'm sorry, I can't help…", legacy rows) counts as absent, and the mandatory
 * "CAMERA OF THIS FRAME:" line is stripped (the script shows the world state only).
 */
function actualEnding(endStateActual?: string | null): string {
  const raw = clean(endStateActual);
  if (!raw || isRefusal(raw)) return "";
  return stripPreviousCameraLine(raw);
}

function durationLabel(sec?: number | null): string {
  const n = typeof sec === "number" && sec > 0 ? Math.round(sec) : null;
  return n ? `${n}s` : "";
}

function sceneKindLabel(kind?: string | null): string {
  const k = clean(kind).toLowerCase();
  if (k === "narration") return "Narration (voice-over)";
  if (k === "action") return "Action";
  return "Dialogue";
}

/** The previous scene's ENDING text, actual last-frame description preferred over the scripted one. */
export function previousEndingText(previous?: PreviousSceneEnding | null): string {
  if (!previous) return "";
  return actualEnding(previous.endStateActual) || clean(previous.endState);
}

/**
 * Build the readable screenplay text for ONE scene.
 * `previous` is the immediately-preceding scene (number - 1), or null/undefined for scene 1.
 */
export function assembleSceneScript(scene: SceneScriptFields, previous?: PreviousSceneEnding | null): string {
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  const header = [`SCENE ${scene.number}`, sceneKindLabel(scene.sceneKind)];
  const dur = durationLabel(scene.durationSec);
  if (dur) header.push(dur);
  lines.push(header.join("  •  "));
  lines.push("");

  // ── OPENING — where this scene begins ──────────────────────────────────────
  // For scene N>1 on a continuous seam the scene STARTS on the previous scene's final frame, so its
  // opening block IS the previous scene's ending. Scene 1 / a sequence break open on their own frame.
  const continuous = scene.number > 1 && !!previous && isContinuousSeam(scene.continuesFrom);
  if (continuous && previous) {
    const prevEnding = previousEndingText(previous);
    lines.push(`OPENING — continues from Scene ${previous.number} (this scene starts on that scene's final frame):`);
    lines.push(prevEnding || "(the previous scene's ending state is not available yet)");
    lines.push("");
    lines.push("The camera opens from a new angle on that same moment; the world does not reset — the action simply carries on from where the previous scene left off.");
    lines.push("");
  } else {
    lines.push("OPENING — fresh start of a new sequence:");
    lines.push(clean(scene.startState) || "(opening state not available yet)");
    lines.push("");
  }

  // ── LOCATION ────────────────────────────────────────────────────────────────
  const loc = clean(scene.locationDesc);
  if (loc) {
    lines.push("LOCATION:");
    lines.push(loc);
    lines.push("");
  }

  // ── Who is in frame ──────────────────────────────────────────────────────────
  const chars = (scene.characters ?? []).map((c) => clean(c)).filter(Boolean);
  if (chars.length) {
    lines.push(`CHARACTERS: ${chars.join(", ")}`);
    lines.push("");
  }
  const presence = clean(scene.presence);
  if (presence) {
    lines.push("AT RISE (who is where at the start):");
    lines.push(presence);
    lines.push("");
  }
  const entrances = clean(scene.entrances);
  if (entrances && entrances.toLowerCase() !== "none") {
    lines.push("ENTRANCES / EXITS:");
    lines.push(entrances);
    lines.push("");
  }

  // ── ACTION ────────────────────────────────────────────────────────────────
  const action = clean(scene.action);
  if (action) {
    lines.push("ACTION:");
    lines.push(action);
    lines.push("");
  }

  // ── DIALOGUE / VOICE-OVER ─────────────────────────────────────────────────
  const kind = clean(scene.sceneKind).toLowerCase();
  if (kind === "narration") {
    const vo = clean(scene.voiceover) || clean(scene.voiceoverLocal);
    if (vo) {
      lines.push("VOICE-OVER (off-screen narrator):");
      lines.push(vo);
      lines.push("");
    }
  } else {
    const dlg = clean(scene.dialogueEn) || clean(scene.dialogue);
    if (dlg && dlg !== "[NO DIALOGUE]") {
      lines.push("DIALOGUE:");
      lines.push(dlg);
      lines.push("");
    }
  }

  // ── END STATE (how this scene ends — the next scene opens here) ─────────────
  const end = actualEnding(scene.endStateActual) || clean(scene.endState);
  if (end) {
    lines.push("END STATE (how this scene ends — the next scene opens exactly here):");
    lines.push(end);
    lines.push("");
  }

  // Collapse any accidental triple blank lines, trim, end with a single newline.
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
