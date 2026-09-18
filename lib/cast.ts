/**
 * Stage 2 (Stage171) — PURE validators for the cast + location pass.
 *
 * These are the acceptance checks for the cast-generation contract described in lib/prompts/cast.ts:
 *   - the season has a TIGHT named cast (≤ 8 named), with MAIN 3–5 and SUPPORT 2–4;
 *   - every NAMED character carries depth (voiceProfile + 2–3 speechTics);
 *   - the season has 4–7 locations, each with a dramaticFunction, and every INTERIOR carries a
 *     region-plate + a non-empty setInventory.
 *
 * All functions are pure and never throw — they return field-named CastError[] so a caller can surface
 * exactly which field failed. This module MAY runtime-import from the leaf prompt module (types + guards
 * + numeric bounds); it references nothing from Prisma / season.ts.
 */
import {
  CAST_MAIN_MIN,
  CAST_MAIN_MAX,
  CAST_SUPPORT_MIN,
  CAST_SUPPORT_MAX,
  CAST_NAMED_MAX,
  CAST_LOCATIONS_MIN,
  CAST_LOCATIONS_MAX,
  CAST_SPEECH_TICS_MIN,
  CAST_SPEECH_TICS_MAX,
  isNamedTier,
  isMainTier,
  isSupportTier,
  type PlannedCharacter,
  type PlannedLocation,
  type CastTier,
} from "@/lib/prompts/cast";

/** A single validation failure, named by the field that failed. */
export interface CastError {
  field: string;
  message: string;
}

/** The result of a validation pass. */
export interface CastValidation {
  ok: boolean;
  errors: CastError[];
}

const nonEmpty = (s?: string | null): boolean => typeof s === "string" && s.trim().length > 0;
const nameOf = (c: { name?: string | null }, i: number): string => (nonEmpty(c.name) ? (c.name as string).trim() : `#${i}`);

/* ───────────────────────── size validator ───────────────────────── */

/**
 * Cast size: at most CAST_NAMED_MAX named characters; MAIN in [CAST_MAIN_MIN, CAST_MAIN_MAX];
 * SUPPORT in [CAST_SUPPORT_MIN, CAST_SUPPORT_MAX]. CROWD / background are not counted.
 */
export function validateCastSize(characters: readonly PlannedCharacter[]): CastError[] {
  const errors: CastError[] = [];
  const list = Array.isArray(characters) ? characters : [];
  const named = list.filter((c) => isNamedTier(c?.tier as CastTier));
  const main = list.filter((c) => isMainTier(c?.tier as CastTier));
  const support = list.filter((c) => isSupportTier(c?.tier as CastTier));

  if (named.length > CAST_NAMED_MAX) {
    errors.push({ field: "characters.named", message: `Named cast must be at most ${CAST_NAMED_MAX}; got ${named.length}.` });
  }
  if (main.length < CAST_MAIN_MIN || main.length > CAST_MAIN_MAX) {
    errors.push({ field: "characters.MAIN", message: `MAIN cast must have ${CAST_MAIN_MIN}-${CAST_MAIN_MAX} characters; got ${main.length}.` });
  }
  if (support.length < CAST_SUPPORT_MIN || support.length > CAST_SUPPORT_MAX) {
    errors.push({ field: "characters.SUPPORT", message: `SUPPORT cast must have ${CAST_SUPPORT_MIN}-${CAST_SUPPORT_MAX} characters; got ${support.length}.` });
  }
  return errors;
}

/* ───────────────────────── depth validator ───────────────────────── */

/**
 * Character depth: every NAMED character has a non-empty voiceProfile and CAST_SPEECH_TICS_MIN..MAX
 * speechTics. CROWD / background characters are exempt.
 */
export function validateCharacterDepth(characters: readonly PlannedCharacter[]): CastError[] {
  const errors: CastError[] = [];
  const list = Array.isArray(characters) ? characters : [];
  list.forEach((c, i) => {
    if (!isNamedTier(c?.tier as CastTier)) return;
    const name = nameOf(c, i);
    if (!nonEmpty(c?.voiceProfile)) {
      errors.push({ field: `characters[${name}].voiceProfile`, message: `Named character "${name}" needs a non-empty voiceProfile.` });
    }
    const tics = Array.isArray(c?.speechTics) ? c!.speechTics!.filter(nonEmpty) : [];
    if (tics.length < CAST_SPEECH_TICS_MIN || tics.length > CAST_SPEECH_TICS_MAX) {
      errors.push({
        field: `characters[${name}].speechTics`,
        message: `Named character "${name}" needs ${CAST_SPEECH_TICS_MIN}-${CAST_SPEECH_TICS_MAX} speechTics; got ${tics.length}.`,
      });
    }
  });
  return errors;
}

/* ───────────────────────── location validator ───────────────────────── */

/**
 * Locations: CAST_LOCATIONS_MIN..MAX per season; each has a non-empty dramaticFunction; every INTERIOR
 * carries a non-empty region-plate and a non-empty setInventory.
 */
export function validateLocations(locations: readonly PlannedLocation[]): CastError[] {
  const errors: CastError[] = [];
  const list = Array.isArray(locations) ? locations : [];

  if (list.length < CAST_LOCATIONS_MIN || list.length > CAST_LOCATIONS_MAX) {
    errors.push({ field: "locations", message: `Season must have ${CAST_LOCATIONS_MIN}-${CAST_LOCATIONS_MAX} locations; got ${list.length}.` });
  }
  list.forEach((loc, i) => {
    const name = nameOf(loc, i);
    if (!nonEmpty(loc?.dramaticFunction)) {
      errors.push({ field: `locations[${name}].dramaticFunction`, message: `Location "${name}" needs a non-empty dramaticFunction.` });
    }
    if (loc?.isInterior) {
      if (!nonEmpty(loc?.regionPlate)) {
        errors.push({ field: `locations[${name}].regionPlate`, message: `Interior location "${name}" must carry a region-plate.` });
      }
      const inv = Array.isArray(loc?.setInventory) ? loc!.setInventory!.filter(nonEmpty) : [];
      if (inv.length < 1) {
        errors.push({ field: `locations[${name}].setInventory`, message: `Interior location "${name}" must carry a non-empty setInventory.` });
      }
    }
  });
  return errors;
}

/* ───────────────────────── aggregate ───────────────────────── */

/** Run every cast/location validator and aggregate the field-named errors. */
export function validateCast(
  characters: readonly PlannedCharacter[],
  locations: readonly PlannedLocation[],
): CastValidation {
  const errors = [
    ...validateCastSize(characters),
    ...validateCharacterDepth(characters),
    ...validateLocations(locations),
  ];
  return { ok: errors.length === 0, errors };
}

/* ───────────────────────── safe coercers (never throw) ───────────────────────── */

/** Coerce a loose object into a PlannedCharacter with safe defaults. Never throws. */
export function normalizeCharacter(raw: unknown): PlannedCharacter {
  const o = (raw ?? {}) as Record<string, unknown>;
  const tierRaw = typeof o.tier === "string" ? o.tier.toUpperCase() : "CROWD";
  const tier = (["MAIN", "SUPPORT", "SUPPORTING", "MINOR", "CROWD"].includes(tierRaw) ? tierRaw : "CROWD") as CastTier;
  const toStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean) : [];
  const rels: Record<string, string> = {};
  if (o.relationshipsTo && typeof o.relationshipsTo === "object" && !Array.isArray(o.relationshipsTo)) {
    for (const [k, v] of Object.entries(o.relationshipsTo as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) rels[k] = v.trim();
    }
  }
  return {
    name: typeof o.name === "string" ? o.name.trim() : "",
    tier,
    voiceProfile: typeof o.voiceProfile === "string" ? o.voiceProfile.trim() : null,
    speechTics: toStrArr(o.speechTics),
    secretsKnown: toStrArr(o.secretsKnown),
    relationshipsTo: rels,
  };
}

/** Coerce a loose object into a PlannedLocation with safe defaults. Never throws. */
export function normalizeLocation(raw: unknown): PlannedLocation {
  const o = (raw ?? {}) as Record<string, unknown>;
  const toStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean) : [];
  return {
    name: typeof o.name === "string" ? o.name.trim() : "",
    dramaticFunction: typeof o.dramaticFunction === "string" ? o.dramaticFunction.trim() : null,
    isInterior: Boolean(o.isInterior),
    regionPlate: typeof o.regionPlate === "string" ? o.regionPlate.trim() : null,
    setInventory: toStrArr(o.setInventory),
  };
}
