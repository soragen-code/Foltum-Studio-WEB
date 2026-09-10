/**
 * Stage 20 tests — lock the episode's single key location across scenes + episode cast = characters
 * actually used in scenes. Run: npx tsx scripts/test-stage20.ts
 *
 * Pure-logic only (NO LLM / network / DB): proves anchorSceneLocation, the robust canChainFrame,
 * the episode-cast union helper, and that the continuity-audit prompt now flags location/setting jumps.
 */
import assert from "node:assert";
import { anchorSceneLocation, LOCATION_CHANGE } from "../lib/location-anchor";
import { canChainFrame, VISUAL_STYLE_ID } from "../lib/visual-style";
import { episodeCastFromScenes } from "../lib/episode-cast";
import { episodeContinuityAuditSystemPrompt } from "../lib/season";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

const CANON = "INT — Ancient stone temple, main hall — golden hour"; // episode canonical location
const DRIFT = "EXT — Open wheat field — noon"; // a drifted scene that must be anchored back

// ── 1. anchorSceneLocation ───────────────────────────────────────────────────────────────────────
ok(
  anchorSceneLocation(DRIFT, CANON, "same-location-continuation") === CANON,
  "drifted non-location-change scene is anchored to the episode canonical location"
);
ok(
  anchorSceneLocation(DRIFT, CANON, "character-moves") === CANON,
  "character-moves scene is also anchored to canonical (still same location)"
);
ok(
  anchorSceneLocation(DRIFT, CANON, undefined) === CANON,
  "missing continuesFrom is treated as non-location-change → anchored"
);
const genuineMove = "EXT — Temple courtyard steps — golden hour";
ok(
  anchorSceneLocation(genuineMove, CANON, LOCATION_CHANGE) === genuineMove,
  "a genuine shown location-change scene keeps its own text"
);
// idempotent: applying twice = same
const once = anchorSceneLocation(DRIFT, CANON, "same-location-continuation");
const twice = anchorSceneLocation(once, CANON, "same-location-continuation");
ok(once === twice && twice === CANON, "anchorSceneLocation is idempotent");
// safe fallback: no canonical text → keep the scene's own text
ok(anchorSceneLocation(DRIFT, "", "same-location-continuation") === DRIFT, "no canonical text → scene text preserved");
ok(anchorSceneLocation("", "", "same-location-continuation") === "", "empty in → empty out");

// ── 2. canChainFrame ─────────────────────────────────────────────────────────────────────────────
// Build the URLs from VISUAL_STYLE_ID so isStyledAsset (path must contain VISUAL_STYLE_ID) recognizes them.
// Extension-less on purpose: isStyledAsset only checks the pathname contains VISUAL_STYLE_ID.
const styled = "https://cdn.example.test/" + VISUAL_STYLE_ID + "/frame-prev";
const unstyled = "https://maxonassets.imgix.net/images/News/architectural-rendering-techniques.jpg?fm=webp&auto=format,compress&w=1920&h=1080&ar=16:9&fit=clip&crop=faces&q=80";
// After A2 the adjacent same-location scenes share the IDENTICAL anchored canonical locationDesc.
const prevStyled = { number: 1, locationDesc: CANON, lastFrameUrl: styled };

ok(
  canChainFrame({ number: 2, locationDesc: CANON, continuesFrom: "same-location-continuation" }, prevStyled) === true,
  "adjacent same-location styled scene → chain allowed"
);
ok(
  canChainFrame({ number: 2, locationDesc: CANON, continuesFrom: LOCATION_CHANGE }, prevStyled) === false,
  "current scene is a shown location-change → chain broken"
);
ok(
  canChainFrame({ number: 3, locationDesc: CANON, continuesFrom: "same-location-continuation" }, prevStyled) === false,
  "non-adjacent scene (3 vs prev 1) → chain broken"
);
ok(
  canChainFrame({ number: 2, locationDesc: CANON, continuesFrom: "same-location-continuation" }, { number: 1, locationDesc: CANON, lastFrameUrl: unstyled }) === false,
  "previous frame is not a styled asset → chain broken"
);
ok(
  canChainFrame({ number: 2, locationDesc: "INT — Ancient stone temple, main hall — golden hour, cut to hours later", continuesFrom: "same-location-continuation" }, prevStyled) === false,
  "explicit time jump ('cut to ... hours later') → chain broken"
);
ok(
  canChainFrame({ number: 2, locationDesc: DRIFT, continuesFrom: "same-location-continuation" }, prevStyled) === false,
  "different canonical location text → chain broken"
);
ok(canChainFrame({ number: 1, locationDesc: CANON, continuesFrom: "new-sequence" }, null) === false, "no previous → chain broken");

// ── 3. episodeCastFromScenes (episode cast = characters actually used) ─────────────────────────────
const declared = ["c1", "c2", "c3"]; // declared cast (outline.characters)
// scenes only use a subset (c1, c2) — c3 never appears
const scenesUsed = [["c1"], ["c1", "c2"], ["c2"], []];
const union = episodeCastFromScenes(scenesUsed, declared);
ok(JSON.stringify(union) === JSON.stringify(["c1", "c2"]), "episode cast = union of scene characters (c3 dropped, order preserved)");
ok(!union.includes("c3"), "a declared character that never appears in a scene is excluded");
// dedup across scenes
ok(episodeCastFromScenes([["c1", "c1"], ["c1"]], declared).length === 1, "union dedupes repeated ids");
// D2 fallback: no scene has any character → declared cast
ok(
  JSON.stringify(episodeCastFromScenes([[], [], null], declared)) === JSON.stringify(declared),
  "empty scene-characters → fall back to declared cast"
);
ok(episodeCastFromScenes([[], []], []).length === 0, "no scene chars and no declared cast → empty (never throws)");

// ── 4. audit prompt flags location/setting jumps ──────────────────────────────────────────────────
const auditRu = episodeContinuityAuditSystemPrompt("ru");
const auditEn = episodeContinuityAuditSystemPrompt("en");
ok(/UNMOTIVATED LOCATION \/ SETTING JUMP/.test(auditRu), "audit prompt (ru) names the location/setting-jump error");
ok(/UNMOTIVATED LOCATION \/ SETTING JUMP/.test(auditEn), "audit prompt (en) names the location/setting-jump error");
ok(/ONE key location/i.test(auditRu), "audit prompt states the episode has ONE key location");
ok(/MUST-FLAG/.test(auditRu), "audit prompt marks the location jump as a must-flag error");

console.log(`\nStage 20: ${pass} checks passed.`);
