/**
 * Stage 2 (Stage171) — CAST + LOCATION generation prompt, seeded from the dramaBible.
 *
 * The dramaBible (Stage 6) is the source of truth for who the season is about. This LEAF module turns a
 * bible into cast-generation instructions:
 *   - MAIN cast = protagonist + antagonist + the B-line characters (3–5 total);
 *   - SUPPORT cast = 2–4 recurring characters; everyone else is nameless background;
 *   - total NAMED characters ≤ 8;
 *   - each named character gets depth: voiceProfile, 2–3 speechTics, the bible secrets they know
 *     (secretsKnown) and their relationshipsTo the rest of the cast;
 *   - locations = 4–7 per season, each with a dramaticFunction; INTERIORS are allowed (an interior must
 *     still carry a region-plate + a setInventory).
 *
 * It imports NOTHING at runtime from lib/season.ts / lib/drama-bible.ts (only `import type`), so it stays
 * a leaf. Numeric bounds are LITERAL mirrors of the lib/cast.ts constants, kept in step by the test.
 * Naming is CULTURE-CONSISTENT with the story's setting / dialogue language — never forced Western.
 */
import type { DramaBible } from "@/lib/prompts/drama-bible";

/** Bumped when the cast-prompt CONTRACT changes; written to Character.castPromptVersion. */
export const CAST_PROMPT_VERSION = "6.6.0";

/* ───────────────────────── numeric mirrors (of lib/cast.ts) ───────────────────────── */

export const CAST_MAIN_MIN = 3;
export const CAST_MAIN_MAX = 5;
export const CAST_SUPPORT_MIN = 2;
export const CAST_SUPPORT_MAX = 4;
export const CAST_NAMED_MAX = 8;
export const CAST_LOCATIONS_MIN = 4;
export const CAST_LOCATIONS_MAX = 7;
export const CAST_SPEECH_TICS_MIN = 2;
export const CAST_SPEECH_TICS_MAX = 3;

/* ───────────────────────── shared cast/location shapes ───────────────────────── */

/** The cast tier used by the size validator. CROWD / background are nameless and not counted. */
export type CastTier = "MAIN" | "SUPPORT" | "SUPPORTING" | "MINOR" | "CROWD";

/** A planned named character — what the cast pass produces and the validators check. */
export interface PlannedCharacter {
  name: string;
  tier: CastTier;
  /** Casting / voice description (timbre, accent, pace). Required for every NAMED character. */
  voiceProfile?: string | null;
  /** 2–3 short verbal habits. */
  speechTics?: string[] | null;
  /** Which bible secrets this character knows (secret text or id). */
  secretsKnown?: string[] | null;
  /** Map of otherCharacterName -> relationship dynamic. */
  relationshipsTo?: Record<string, string> | null;
}

/** A planned location — 4–7 per season; interiors allowed but must carry region-plate + setInventory. */
export interface PlannedLocation {
  name: string;
  /** Why this place matters to the drama (one sentence). Required. */
  dramaticFunction?: string | null;
  /** True when the location is an interior (an interior needs a region-plate + setInventory). */
  isInterior?: boolean;
  /** The fixed spatial region-plate id/text (mandatory for interiors). */
  regionPlate?: string | null;
  /** Set-dressing inventory (mandatory for interiors). */
  setInventory?: string[] | null;
}

/** True for a NAMED tier (counts toward the ≤8 named-cast budget). CROWD is nameless background. */
export function isNamedTier(tier: CastTier | string | null | undefined): boolean {
  const t = (tier ?? "").toUpperCase();
  return t === "MAIN" || t === "SUPPORT" || t === "SUPPORTING" || t === "MINOR";
}

/** True for the MAIN tier. */
export const isMainTier = (t: CastTier | string | null | undefined): boolean => (t ?? "").toUpperCase() === "MAIN";
/** True for a SUPPORT / SUPPORTING tier (treated as one). */
export const isSupportTier = (t: CastTier | string | null | undefined): boolean => {
  const u = (t ?? "").toUpperCase();
  return u === "SUPPORT" || u === "SUPPORTING";
};

/* ───────────────────────── bible → cast threading (pure) ───────────────────────── */

const oneLine = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim();

/**
 * The MAIN-cast seed names from a bible: the B-line characters plus a protagonist + antagonist slot.
 * The bible names the protagonist/antagonist only by arc, so their NAMES come from the cast pass; the
 * B-line characters are named in the bible and seed the rest of the MAIN tier. Pure. Empty when no bible.
 */
export function mainCastSeedFromBible(bible?: DramaBible | null): string[] {
  if (!bible) return [];
  const seed = new Set<string>();
  (bible.bLine?.characters ?? []).forEach((n) => {
    const c = oneLine(n);
    if (c) seed.add(c);
  });
  (bible.relationships ?? []).forEach((r) => {
    [r?.a, r?.b].forEach((n) => {
      const c = oneLine(n);
      if (c) seed.add(c);
    });
  });
  return [...seed];
}

/** The bible secrets a named character knows (knownBy includes their name). Pure. */
export function secretsKnownFor(name: string, bible?: DramaBible | null): string[] {
  if (!bible) return [];
  const target = oneLine(name).toLowerCase();
  return (bible.secrets ?? [])
    .filter((s) => (s?.knownBy ?? []).some((k) => oneLine(k).toLowerCase() === target))
    .map((s) => oneLine(s.secret))
    .filter(Boolean);
}

/** The character's relationshipsTo map (otherName -> dynamic) drawn from the bible relationships. Pure. */
export function relationshipsToFor(name: string, bible?: DramaBible | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!bible) return out;
  const target = oneLine(name).toLowerCase();
  (bible.relationships ?? []).forEach((r) => {
    const a = oneLine(r?.a);
    const b = oneLine(r?.b);
    const dynamic = oneLine(r?.dynamic) || oneLine(r?.tension);
    if (!dynamic) return;
    if (a.toLowerCase() === target && b) out[b] = dynamic;
    else if (b.toLowerCase() === target && a) out[a] = dynamic;
  });
  return out;
}

/**
 * Thread a bible into a planned character: fill secretsKnown + relationshipsTo from the bible (without
 * overwriting values already present). DEFENSIVE: with no bible it returns the character unchanged, so
 * old projects without a dramaBible keep generating. Pure — returns a NEW object.
 */
export function threadBibleIntoCharacter(char: PlannedCharacter, bible?: DramaBible | null): PlannedCharacter {
  if (!bible) return { ...char };
  const secretsKnown = char.secretsKnown && char.secretsKnown.length ? char.secretsKnown : secretsKnownFor(char.name, bible);
  const existingRels = char.relationshipsTo && Object.keys(char.relationshipsTo).length ? char.relationshipsTo : relationshipsToFor(char.name, bible);
  return { ...char, secretsKnown, relationshipsTo: existingRels };
}

/* ───────────────────────── rule strings ───────────────────────── */

export const CAST_SIZE_RULE =
  `CAST SIZE (from the drama bible): the season has a TIGHT named cast — at most ${CAST_NAMED_MAX} named characters total. ` +
  `MAIN cast = the protagonist + the antagonist + the B-line characters (${CAST_MAIN_MIN}–${CAST_MAIN_MAX} people). ` +
  `SUPPORT cast = ${CAST_SUPPORT_MIN}–${CAST_SUPPORT_MAX} recurring characters close to the leads. Everyone else is NAMELESS background (a CROWD group), never a named character.`;

export const CAST_DEPTH_RULE =
  `CHARACTER DEPTH: every NAMED character gets a "voiceProfile" (casting / voice description — timbre, accent, pace), ` +
  `"speechTics" (${CAST_SPEECH_TICS_MIN}–${CAST_SPEECH_TICS_MAX} short verbal habits), "secretsKnown" (which of the bible's secrets this character knows), ` +
  `and "relationshipsTo" (a map of other-character-name → the relationship dynamic between them, drawn from the bible's relationships).`;

export const CAST_NAMING_RULE =
  "NAMING: names are CULTURALLY CONSISTENT with the story's setting, region-plate and the project's dialogue language — never forced Western / Latin-only. Default to English names only when no setting or dialogue language is given. Keep one naming culture across the whole cast.";

export const CAST_LOCATION_RULE =
  `LOCATIONS: ${CAST_LOCATIONS_MIN}–${CAST_LOCATIONS_MAX} locations for the season. Each location has a "dramaticFunction" (one sentence: why this place matters to the drama). ` +
  "INTERIORS ARE ALLOWED — pick whatever mix of interiors and exteriors the STORY needs; there is NO rule that exteriors must predominate. " +
  "When a location is an INTERIOR it MUST still carry a region-plate (a fixed spatial layout the camera re-frames but never rebuilds) AND a setInventory (the set-dressing objects with fixed placements), so the room stays continuous across shots.";

/* ───────────────────────── prompt builders ───────────────────────── */

export const CAST_SYSTEM =
  "You are a casting + world director for a short-form vertical (9:16) drama season. Given the season's DRAMA BIBLE, " +
  "produce the season's NAMED cast and its locations. Apply ALL of these rules:\n" +
  `- ${CAST_SIZE_RULE}\n` +
  `- ${CAST_DEPTH_RULE}\n` +
  `- ${CAST_NAMING_RULE}\n` +
  `- ${CAST_LOCATION_RULE}\n` +
  "Return JSON: { \"characters\": [ { \"name\": \"<name>\", \"tier\": \"MAIN|SUPPORT|MINOR|CROWD\", \"voiceProfile\": \"<string>\", " +
  "\"speechTics\": [\"<tic>\", ...], \"secretsKnown\": [\"<secret>\", ...], \"relationshipsTo\": { \"<otherName>\": \"<dynamic>\" } }, ... ], " +
  "\"locations\": [ { \"name\": \"<name>\", \"dramaticFunction\": \"<one sentence>\", \"isInterior\": <bool>, \"regionPlate\": \"<layout|null>\", \"setInventory\": [\"<object — placement>\", ...] }, ... ] }.";

/**
 * The user message for the cast pass. DEFENSIVE: with no bible it degrades to a plain brief (old projects
 * without a dramaBible still generate a cast, just without bible-seeding).
 */
export function castUserPrompt(bible?: DramaBible | null, opts: { dialogueLanguage?: string | null; setting?: string | null } = {}): string {
  const lang = oneLine(opts.dialogueLanguage) || "English";
  const setting = oneLine(opts.setting);
  const head = [
    `Dialogue language: ${lang}. Name the cast to fit this language / setting${setting ? ` (${setting})` : ""}.`,
  ];
  if (!bible) {
    return [
      ...head,
      "No drama bible is available for this project — generate a tight named cast and locations from the synopsis alone, still honoring the cast-size, depth, naming and location rules.",
      "Return only the JSON.",
    ].join("\n");
  }
  const seed = mainCastSeedFromBible(bible);
  const secrets = (bible.secrets ?? []).filter((s) => s && s.secret);
  const rels = (bible.relationships ?? []).filter((r) => r && r.a && r.b);
  const body = [
    `THEME: ${oneLine(bible.theme)}`,
    `PROTAGONIST ARC: wants ${oneLine(bible.protagonist?.want)}; needs ${oneLine(bible.protagonist?.need)}; flaw ${oneLine(bible.protagonist?.flaw)}.`,
    `ANTAGONIST: goal ${oneLine(bible.antagonist?.goal)}; pressure ${oneLine(bible.antagonist?.pressureMechanism)}.`,
    `B-LINE: ${oneLine(bible.bLine?.conflict)} — characters: ${(bible.bLine?.characters ?? []).map(oneLine).filter(Boolean).join(", ") || "(name them)"}.`,
    seed.length ? `MAIN-CAST SEED (name these as MAIN, plus a named protagonist + antagonist): ${seed.join(", ")}.` : "",
    secrets.length ? `SECRETS (assign each character's secretsKnown from knownBy): ${secrets.map((s) => `"${oneLine(s.secret)}" known by [${(s.knownBy ?? []).map(oneLine).join(", ")}]`).join("; ")}` : "",
    rels.length ? `RELATIONSHIPS (fill relationshipsTo from these): ${rels.map((r) => `${oneLine(r.a)}↔${oneLine(r.b)}: ${oneLine(r.dynamic)}`).join("; ")}` : "",
  ].filter(Boolean).join("\n");
  return [...head, "Build the cast + locations from this drama bible:", body, "Return only the JSON."].join("\n");
}
