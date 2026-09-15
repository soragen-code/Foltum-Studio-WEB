/**
 * Stage 126 — SCREEN-SIDE CONTINUITY / LINE OF ACTION (the 180-degree rule), WITHOUT locking the camera.
 *
 * Bug: between two consecutive scenes of the same location the characters swapped screen sides
 * (frame-left ↔ frame-right). Nothing carried each character's screen side across the cut, so the
 * video model was free to "cross the line" and re-render the pair from the opposite side, flipping
 * who stands where. The fix keeps the camera completely free (any angle, height, distance, move) and
 * only pins the LEFT/RIGHT arrangement of the people: whoever was on the left of frame at the end of
 * the previous shot stays on the left, whoever was on the right stays on the right — unless a
 * character physically moves across on screen.
 *
 * This module is PURE and deterministic (no network / LLM / DB). The screen side of each character is
 * READ from the previous scene's actual last-frame description (lib/frame-state.ts writes it with
 * "frame-left / frame-right / centre" wording) — the same text that already opens the next scene as
 * its OPENING STATE. No new DB field is needed: the staging map is derived at prompt-assembly time and
 * carried into the next scene's prompt as a directive.
 */

export type ScreenSide = "left" | "right" | "center";

export interface StagingSlot {
  name: string;
  side: ScreenSide;
}

/** How far (chars) a side keyword may sit from a character name to be considered "about" that name. */
const SIDE_WINDOW = 110;

// Deterministic side markers, most specific phrasings first. "left"/"right" as bare words come last so
// specific "frame-left" style phrases win the distance race when both appear.
const LEFT_RE =
  /\b(?:frame[- ]?left|screen[- ]?left|left[- ]?hand|left(?:[- ]?hand)? side|left of (?:the )?frame|(?:on|to|at|toward[s]?) the left|left)\b/gi;
const RIGHT_RE =
  /\b(?:frame[- ]?right|screen[- ]?right|right[- ]?hand|right(?:[- ]?hand)? side|right of (?:the )?frame|(?:on|to|at|toward[s]?) the right|right)\b/gi;
const CENTER_RE =
  /\b(?:frame[- ]?cent(?:er|re)|dead[- ]?cent(?:er|re)|cent(?:er|re) of (?:the )?frame|in the cent(?:er|re)|mid[- ]?frame|middle of (?:the )?frame|cent(?:er|re)|middle)\b/gi;

const SIDE_RES: Array<{ side: ScreenSide; re: RegExp }> = [
  { side: "left", re: LEFT_RE },
  { side: "right", re: RIGHT_RE },
  { side: "center", re: CENTER_RE },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All start indices where `name` appears (case-insensitive, word-boundary-ish). */
function nameOccurrences(text: string, name: string): number[] {
  const n = name.trim();
  if (!n) return [];
  const re = new RegExp(`(?:^|[^a-z0-9])(${escapeRegExp(n)})(?![a-z0-9])`, "gi");
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m.index + (m[0].length - m[1].length));
    if (out.length > 200) break;
  }
  return out;
}

/** Match spans (start index) of a side regex within the text. */
function sideMatches(text: string, re: RegExp): number[] {
  re.lastIndex = 0;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
    if (out.length > 400) break;
  }
  return out;
}

/**
 * The screen side of `name` in `text`, or null when it cannot be determined. Deterministic: for every
 * occurrence of the name it finds the nearest side keyword within SIDE_WINDOW; the side of the single
 * closest name↔keyword pairing across the whole text wins (ties resolved by marker priority order).
 */
export function detectScreenSide(text: string | null | undefined, name: string): ScreenSide | null {
  const t = (text ?? "").toString();
  if (!t.trim()) return null;
  const occ = nameOccurrences(t, name);
  if (!occ.length) return null;
  const perSide = SIDE_RES.map((s) => ({ side: s.side, hits: sideMatches(t, s.re) }));
  let best: { side: ScreenSide; dist: number } | null = null;
  for (const pos of occ) {
    for (const { side, hits } of perSide) {
      for (const h of hits) {
        const dist = Math.abs(h - pos);
        if (dist > SIDE_WINDOW) continue;
        if (!best || dist < best.dist) best = { side, dist };
      }
    }
  }
  return best ? best.side : null;
}

/**
 * Build the staging map for the NEXT scene: each of THIS scene's present characters mapped to the
 * screen side it held in the previous scene's last-frame text. Only characters whose side can be read
 * are included; order follows `names`. Pure.
 */
export function buildStagingMap(
  previousStateText: string | null | undefined,
  names: readonly string[],
): StagingSlot[] {
  const seen = new Set<string>();
  const out: StagingSlot[] = [];
  for (const raw of names) {
    const name = (raw ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const side = detectScreenSide(previousStateText, name);
    if (side) out.push({ name, side });
  }
  return out;
}

function sidePhrase(side: ScreenSide): string {
  if (side === "left") return "on the LEFT of frame";
  if (side === "right") return "on the RIGHT of frame";
  return "in the CENTRE of frame";
}

/**
 * The "carry the screen sides over" line for a non-empty staging map, or "" when nothing was
 * detected. Deterministic wording so the prompt is byte-stable for the same input.
 */
export function stagingCarryLine(map: readonly StagingSlot[]): string {
  if (!map.length) return "";
  const parts = map.map((s) => `${s.name} stays ${sidePhrase(s.side)}`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return (
    `SCREEN SIDES (carry over from the previous shot — keep the SAME left-to-right arrangement): ${list}. ` +
    `These screen positions are inherited from the end of the previous shot and do not change between shots.`
  );
}

/**
 * The LINE OF ACTION (180-degree rule) directive. It preserves each character's screen side across
 * the cut WITHOUT restricting the camera: the camera may move to any new angle, height, distance,
 * shot scale, and may push in, arc or track — it simply must not cross the axis between the characters
 * so as to flip their left/right places. A side change is allowed ONLY when a character's own movement
 * shows it on screen. It does NOT conflict with EYELINES CONNECT (characters still turn head/eyes
 * toward whoever they address from their kept sides; nobody squares up to the camera).
 */
export const LINE_OF_ACTION_LINE =
  "LINE OF ACTION (180-degree rule — screen sides are preserved, the camera stays free): the characters keep the SAME left-to-right screen arrangement they had at the end of the previous shot — whoever was on the LEFT of frame stays on the left, whoever was on the RIGHT stays on the right, and anyone centred stays centred. The camera remains completely free: it may move to any new angle, height, distance or shot scale and may push in, pull out, arc or track around the scene. What it must NOT do is jump across the line of action (the invisible axis running between the characters) in a way that swaps their left/right places — the two never trade sides between shots just because the camera moved. Characters change sides ONLY when their own on-screen movement shows it (one physically walks around, crosses in front of or steps past the other within the shot). This never makes anyone face the viewer: they still turn their head and eyes toward whoever they address, keeping eyelines connected, just from their preserved screen sides.";

/**
 * Combine the (optional) screen-side carry line with the always-on line-of-action directive for a
 * CONTINUING shot. Returns "" when there is nothing to say (never happens on a continuing shot because
 * the axis rule is always emitted, but kept defensive). Pure.
 */
export function stagingContinuityBlock(
  previousStateText: string | null | undefined,
  names: readonly string[],
): string {
  const carry = stagingCarryLine(buildStagingMap(previousStateText, names));
  return [carry, LINE_OF_ACTION_LINE].filter(Boolean).join("\n");
}
