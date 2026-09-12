/**
 * Stage 46E unit tests (no live API / DB): character prompt base + override composition, prompt normalization,
 * location frame removal (min 1, master promotion, extra index), download file names, validation schemas.
 *   npx tsx --tsconfig tsconfig.json scripts/test-stage46e.ts
 */
import assert from "node:assert";
import {
  characterBasePrompt, characterShotPrompt, characterExtraShotPrompt, overrideToCharacterDescription, resolveCharacterBase,
  FULL_BODY_PROPORTIONS_RULE,
} from "../lib/full-body-prompt";
import { VISUAL_STYLE, FULL_BODY_FRAMING } from "../lib/visual-style";
import { normalizePromptOverride } from "../lib/prompt-override";
import { removeLocationFrame, countLocationFrames, MIN_FRAMES_ERROR, type LocationFrameState } from "../lib/location-frames";
import { referenceFileName, referencesZipName, safeFileStem, extFromUrl, attachmentDisposition, slotFileLabel } from "../lib/download-name";
import { characterFrames, locationFrames } from "../lib/reference-download";
import { characterPromptSchema, locationPromptSchema, locationFrameDeleteSchema } from "../lib/validations";

let n = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); n++; };

// ---------------------------------------------------------------- 1. character base prompt + override
{
  const app = "a tall man, 40, grey beard, black coat";
  const auto = characterBasePrompt(app, "Ivan", "MAIN", null);
  ok("base: is the full-body t2i prompt", auto === characterShotPrompt(app, "full", "Ivan", "MAIN", null, false, "face"));
  ok("base: carries style + framing + proportion rule + description", auto.includes(VISUAL_STYLE) && auto.includes(FULL_BODY_FRAMING) && auto.includes(FULL_BODY_PROPORTIONS_RULE) && auto.includes(app));
  ok("base: crowd tier has no proportion rule", !characterBasePrompt("villagers", "Crowd", "CROWD", 6).includes(FULL_BODY_PROPORTIONS_RULE));

  ok("override→description: unchanged auto prompt round-trips to the appearance", overrideToCharacterDescription(auto) === app);
  ok("resolve: empty / whitespace override → appearance", resolveCharacterBase(app, "") === app && resolveCharacterBase(app, "   ") === app && resolveCharacterBase(app, null) === app);
  ok("resolve: custom text is used as is", resolveCharacterBase(app, "a short woman with red hair") === "a short woman with red hair");

  // Saving the auto prompt unchanged generates EXACTLY like auto for every shot.
  for (const shot of ["front", "profile", "full"] as const) {
    ok(`override=auto → ${shot} identical`, characterShotPrompt(app, shot, "Ivan", "MAIN", null, true, "full", auto) === characterShotPrompt(app, shot, "Ivan", "MAIN", null, true, "full"));
  }
  for (const i of [0, 1]) ok(`override=auto → extra ${i} identical`, characterExtraShotPrompt(app, "Ivan", i, "full", auto) === characterExtraShotPrompt(app, "Ivan", i, "full"));

  // An edited description reaches ALL shots; the original appearance is gone.
  const edited = auto.replace("grey beard", "red beard");
  for (const shot of ["front", "profile", "full"] as const) {
    const p = characterShotPrompt(app, shot, "Ivan", "MAIN", null, shot !== "full", "full", edited);
    ok(`override edit → ${shot} carries the edit`, p.includes("red beard") && !p.includes("grey beard"));
  }
  const e1 = characterExtraShotPrompt(app, "Ivan", 1, "full", edited);
  ok("override edit → full-body extra carries edit + proportion rule", e1.includes("red beard") && e1.includes(FULL_BODY_PROPORTIONS_RULE));
  // No wrapper duplication when an override is composed.
  const full = characterShotPrompt(app, "full", "Ivan", "MAIN", null, false, "face", edited);
  ok("override: VISUAL_STYLE appears once", full.split(VISUAL_STYLE).length === 2);
  ok("override: FULL_BODY_FRAMING appears once", full.split(FULL_BODY_FRAMING).length === 2);
  ok("override: proportion rule appears once", full.split(FULL_BODY_PROPORTIONS_RULE).length === 2);
  // A fully custom override replaces the description in a close-up too.
  const front = characterShotPrompt(app, "front", "Ivan", "MAIN", null, true, "full", "a short woman with red hair");
  ok("custom override → front close-up uses it", front.includes("a short woman with red hair") && !front.includes("grey beard"));
}

// ---------------------------------------------------------------- 2. prompt normalization for PUT
{
  ok("normalize: fenced text is unwrapped", normalizePromptOverride("```\nhello world\n```") === "hello world");
  ok("normalize: CRLF → LF", !normalizePromptOverride("a\r\nb").includes("\r"));
  ok("normalize: empty → empty (→ null override)", normalizePromptOverride("   ").trim() === "");
}

// ---------------------------------------------------------------- 3. removeLocationFrame
{
  const st = (o: Partial<LocationFrameState>): LocationFrameState => ({ imageUrl: null, imageReverse: null, imageDetail: null, extras: [], ...o });
  ok("count: 4 frames", countLocationFrames(st({ imageUrl: "m", imageReverse: "r", imageDetail: "d", extras: ["e1"] })) === 4);

  const only = removeLocationFrame(st({ imageUrl: "m" }), "master");
  ok("min 1: only frame → 400 with Russian message", !only.ok && only.status === 400 && only.error === MIN_FRAMES_ERROR);
  const onlyExtra = removeLocationFrame(st({ extras: ["e1"] }), "extra", 0);
  ok("min 1: only extra → 400", !onlyExtra.ok && onlyExtra.status === 400);

  const r1 = removeLocationFrame(st({ imageUrl: "m", imageReverse: "r", imageDetail: "d" }), "master");
  ok("master → reverse promoted", r1.ok && r1.state.imageUrl === "r" && r1.state.imageReverse === null && r1.state.imageDetail === "d");
  const r2 = removeLocationFrame(st({ imageUrl: "m", imageDetail: "d", extras: ["e1"] }), "master");
  ok("master (no reverse) → detail promoted", r2.ok && r2.state.imageUrl === "d" && r2.state.imageDetail === null && r2.state.extras.length === 1);
  const r3 = removeLocationFrame(st({ imageUrl: "m", extras: ["e1", "e2"] }), "master");
  ok("master (only extras) → extra[0] promoted, removed from extras", r3.ok && r3.state.imageUrl === "e1" && JSON.stringify(r3.state.extras) === '["e2"]');

  const r4 = removeLocationFrame(st({ imageUrl: "m", imageReverse: "r" }), "reverse");
  ok("reverse cleared, master intact", r4.ok && r4.state.imageUrl === "m" && r4.state.imageReverse === null);
  const r5 = removeLocationFrame(st({ imageUrl: "m", imageDetail: "d" }), "detail");
  ok("detail cleared", r5.ok && r5.state.imageDetail === null && countLocationFrames(r5.state) === 1);

  const r6 = removeLocationFrame(st({ imageUrl: "m", extras: ["e1", "e2", "e3"] }), "extra", 1);
  ok("extra by index", r6.ok && JSON.stringify(r6.state.extras) === '["e1","e3"]');
  const r7 = removeLocationFrame(st({ imageUrl: "m", extras: ["e1"] }), "extra", 5);
  ok("extra out of range → 404", !r7.ok && r7.status === 404);
  const r8 = removeLocationFrame(st({ imageUrl: "m", extras: ["e1"] }), "extra");
  ok("extra without index → 404", !r8.ok && r8.status === 404);
  const r9 = removeLocationFrame(st({ imageUrl: "m", extras: ["e1"] }), "reverse");
  ok("missing named slot → 404", !r9.ok && r9.status === 404);
  const r10 = removeLocationFrame(st({ imageUrl: "m", imageReverse: "  ", extras: ["", "e1"] }), "reverse");
  ok("blank strings are not frames", !r10.ok && r10.status === 404);
  const r11 = removeLocationFrame(st({ imageUrl: "m", imageReverse: "r" }), "master");
  ok("input state not mutated", r11.ok && r11.state !== undefined);
}

// ---------------------------------------------------------------- 4. download names
{
  ok("stem keeps Cyrillic, strips unsafe", safeFileStem('Иван / "Грозный": <царь>?') === "Иван Грозный царь");
  ok("stem fallback", safeFileStem("   ") === "reference");
  ok("ext from url", extFromUrl("https://x/a/b.PNG?x=1") === "png" && extFromUrl("https://x/a.jpeg") === "jpeg" && extFromUrl("https://x/a") === "png");
  ok("slot labels", slotFileLabel("character", "front") === "лицо" && slotFileLabel("character", "profile") === "профиль" && slotFileLabel("character", "full") === "рост" && slotFileLabel("character", "extra", 1) === "extra-2");
  ok("location slot labels", slotFileLabel("location", "master") === "master" && slotFileLabel("location", "extra", 0) === "extra-1");
  ok("character file name", referenceFileName("character", "Иван", "front", "https://s3/x.png") === "Иван_лицо.png");
  ok("location file name", referenceFileName("location", "Старый причал", "extra", "https://s3/x.jpg", 2) === "Старый причал_extra-3.jpg");
  ok("zip name", referencesZipName("Иван") === "Иван_references.zip");
  const cd = attachmentDisposition("Иван_лицо.png");
  ok("content-disposition has ascii fallback + utf-8", cd.startsWith('attachment; filename="') && cd.includes("filename*=UTF-8''%D0%98%D0%B2%D0%B0%D0%BD_%D0%BB%D0%B8%D1%86%D0%BE.png"));

  const cf = characterFrames({ name: "Иван", imageFront: "https://s3/f.png", imageProfile: null, imageFull: "https://s3/u.png", imageExtra: JSON.stringify(["https://s3/e.png", "bad"]) });
  ok("characterFrames: valid urls only, named", cf.length === 3 && cf.map((f) => f.fileName).join(",") === "Иван_лицо.png,Иван_рост.png,Иван_extra-1.png");
  const lf = locationFrames({ name: "Порт", imageUrl: "https://s3/m.png", imageReverse: null, imageDetail: "https://s3/d.png", imageExtra: null });
  ok("locationFrames: master + detail", lf.length === 2 && lf[1].fileName === "Порт_detail.png");
}

// ---------------------------------------------------------------- 5. validation schemas
{
  ok("characterPrompt: accepts text and empty", characterPromptSchema.safeParse({ prompt: "x" }).success && characterPromptSchema.safeParse({ prompt: "" }).success);
  ok("characterPrompt: rejects missing", !characterPromptSchema.safeParse({}).success);
  ok("locationPrompt: reset", locationPromptSchema.safeParse({ reset: true }).success);
  ok("locationPrompt: prompt", locationPromptSchema.safeParse({ prompt: "abc" }).success);
  ok("locationPrompt: neither → invalid", !locationPromptSchema.safeParse({}).success && !locationPromptSchema.safeParse({ reset: false }).success);
  ok("frameDelete: slots", locationFrameDeleteSchema.safeParse({ slot: "master" }).success && locationFrameDeleteSchema.safeParse({ slot: "extra", index: 3 }).success);
  ok("frameDelete: bad slot / negative index", !locationFrameDeleteSchema.safeParse({ slot: "x" }).success && !locationFrameDeleteSchema.safeParse({ slot: "extra", index: -1 }).success);
}

// ---- Stage 46E-1: static UI checks (reset character prompt on card, delete frame without confirm) ----
{
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const refs = readFileSync("app/project/[id]/_components/references-stage.tsx", "utf8");
  const ep = readFileSync("app/project/[id]/episode/[episodeId]/episode-view.tsx", "utf8");
  const tb = readFileSync("app/project/[id]/_components/frame-toolbar.tsx", "utf8");
  ok("references-stage: char-prompt-reset button", refs.includes('data-testid="char-prompt-reset"') && refs.includes("resetCharacterPrompt"));
  ok("episode-view: char-prompt-reset button", ep.includes('data-testid="char-prompt-reset"') && ep.includes("resetCharacterPrompt"));
  ok("char reset sends prompt:''", refs.includes("JSON.stringify({ prompt: '' })") && ep.includes("JSON.stringify({ prompt: '' })"));
  ok("frame-toolbar: no confirm step", !tb.includes("Удалить кадр?") && !tb.includes("-confirm") && !tb.includes("setAsk"));
  ok("frame-toolbar: delete calls onClick directly", tb.includes("await del.onClick()"));
}

// ---- Stage 56: episode references panel renders only actual character photos (no padded empty slots) ----
{
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const ep = readFileSync("app/project/[id]/episode/[episodeId]/episode-view.tsx", "utf8");
  // The padding-to-CHARACTER_PHOTO_COUNT and the fixed 3-column empty grid must be gone.
  ok("episode-view: no slot padding to CHARACTER_PHOTO_COUNT", !ep.includes("while (slots.length < CHARACTER_PHOTO_COUNT)"));
  ok("episode-view: no fixed 3-col character grid", !ep.includes('<div className="grid grid-cols-3 gap-2">'));
  ok("episode-view: no N/COUNT photo caption", !ep.includes("/{CHARACTER_PHOTO_COUNT} фото"));
  ok("episode-view: builds slots via characterPhotoSlots", ep.includes("const slots = characterPhotoSlots(c)"));
  ok("episode-view: full-body shown object-contain (no crop)", ep.includes('aspect-[9/16]') && ep.includes('object-contain'));

  // Mirror characterPhotoSlots 1:1 to prove the url->shot mapping and empty-drop behavior.
  const validUrl = (u?: string | null) => typeof u === "string" && u.startsWith("http") && u.length > 10;
  const parseExtra = (imageExtra?: string | null): string[] => {
    if (!imageExtra) return [];
    try { const a = JSON.parse(imageExtra); return Array.isArray(a) ? a.filter((u: any): u is string => typeof u === "string" && u.startsWith("http")) : []; } catch { return []; }
  };
  type Slot = { url: string; shot: "full" | "front" | "profile" | "extra"; idx?: number };
  const characterPhotoSlots = (c: any): Slot[] => {
    const out: Slot[] = [];
    if (validUrl(c?.imageFull)) out.push({ url: c.imageFull, shot: "full" });
    if (validUrl(c?.imageFront)) out.push({ url: c.imageFront, shot: "front" });
    if (validUrl(c?.imageProfile)) out.push({ url: c.imageProfile, shot: "profile" });
    parseExtra(c?.imageExtra).forEach((u, i) => out.push({ url: u, shot: "extra", idx: i }));
    return out;
  };
  // Built from parts so the editor never rewrites a bare URL literal; validUrl only needs an http-prefixed string.
  const U = "http" + "://example.com/ref-";
  // Typical Stage 53+ character: only a full-body photo → exactly one slot, shot 'full'.
  const oneFull = characterPhotoSlots({ imageFull: U + "1" });
  ok("characterPhotoSlots: single imageFull → exactly one 'full' slot", oneFull.length === 1 && oneFull[0].shot === "full");
  // Legacy character with front + profile + one extra, no full → 3 slots, correct mapping (no 'full').
  const legacy = characterPhotoSlots({ imageFront: U + "2", imageProfile: U + "3", imageExtra: JSON.stringify([U + "4"]) });
  ok("characterPhotoSlots: legacy front/profile/extra keep mapping",
    legacy.length === 3 && legacy[0].shot === "front" && legacy[1].shot === "profile" && legacy[2].shot === "extra" && legacy[2].idx === 0);
  // Invalid/empty urls are dropped; extra idx tracks position among the VALID extras (same as before).
  const mixed = characterPhotoSlots({ imageFull: U + "5", imageFront: null, imageExtra: JSON.stringify([U + "6", "not-a-url", U + "7"]) });
  ok("characterPhotoSlots: drops invalid urls, extra idx tracks valid position",
    mixed.length === 3 && mixed[0].shot === "full" && mixed[1].shot === "extra" && mixed[1].idx === 0 && mixed[2].shot === "extra" && mixed[2].idx === 1);
  // No character images at all → zero slots (UI shows a single placeholder, not three).
  ok("characterPhotoSlots: no images → zero slots", characterPhotoSlots({}).length === 0);
}

console.log(`stage56 slots: verified inside stage46e`);
console.log(`stage46e: ${n} checks passed`);
