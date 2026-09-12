/** Stage 46B-1 unit tests (no live API): look cache hash, look-result validator, front+full references, cap trimming, look-neutral frame prompt. */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { lookHash, validateLookResult, hasAllTagsInOrder, rewriteSceneLook, PROMPT_TAGS, type LookTexts } from "../lib/character-look";
import { buildScenePrompt, REFERENCE_IMAGE_CAP } from "../lib/scene-prompt";
import { FRAME_STATE_SYSTEM_PROMPT } from "../lib/frame-state";
import { VISUAL_STYLE_ID } from "../lib/visual-style";

let n = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); n++; };

const styledUrl = (k: string) => `https://cdn.example.com/public/references/p1/${VISUAL_STYLE_ID}/${k}.jpg`;
const prompt9 = PROMPT_TAGS.map(t => `${t}: something about ${t.toLowerCase()} with Anna, red dress, short black hair.`).join("\n");
const original: LookTexts = { videoPrompt: prompt9, startState: "WORLD: Anna in a red dress stands left. CAMERA: wide.", endState: "WORLD: Anna in a red dress sits. CAMERA: medium.", openingState: null };
const anna = { characterId: "anna", name: "Anna", age: "34", appearance: "red dress, short black hair" };
const mark = { characterId: "mark", name: "Mark", age: "40", appearance: "grey beard, navy suit" };

// 1. hash
const h1 = lookHash([anna, mark], original);
ok("hash is stable for same input (any order)", lookHash([mark, anna], original) === h1);
ok("hash changes when appearance changes", lookHash([{ ...anna, appearance: "blue coat, long blond hair" }, mark], original) !== h1);
ok("hash changes when age changes", lookHash([{ ...anna, age: "35" }, mark], original) !== h1);
ok("hash changes when original text changes", lookHash([anna, mark], { ...original, endState: "other" }) !== h1);
ok("hash unchanged for irrelevant fields", lookHash([{ ...anna, name: "Anna " }, mark], original) === h1);

// 2. validator
ok("all 9 tags in order accepted", hasAllTagsInOrder(prompt9));
ok("missing tag rejected", !hasAllTagsInOrder(prompt9.replace("[GAZE]", "[LOOK]")));
ok("wrong order rejected", !hasAllTagsInOrder(prompt9.replace("[GAZE]", "[X]").replace("[TRANSITION]", "[GAZE] [TRANSITION]")));
ok("empty rejected", !hasAllTagsInOrder(""));
const good = validateLookResult({ videoPrompt: prompt9.replace(/red dress/g, "blue coat"), startState: "WORLD: Anna in a blue coat stands left. CAMERA: wide.", endState: "WORLD: Anna in a blue coat sits. CAMERA: medium.", openingState: null }, original);
ok("valid result accepted", !!good && good.videoPrompt.includes("blue coat") && good.startState!.includes("blue coat") && good.openingState === null);
ok("broken videoPrompt → null (fallback)", validateLookResult({ videoPrompt: "no tags here", startState: "x", endState: "y", openingState: null }, original) === null);
ok("non-object → null", validateLookResult("nope", original) === null);
const shortState = validateLookResult({ videoPrompt: prompt9, startState: "short", endState: null }, original)!;
ok("too-short / missing state falls back to the original state", shortState.startState === original.startState && shortState.endState === original.endState);

// 3. rewriteSceneLook: cache reuse, fallback on error / invalid, timeout
(async () => {
  let calls = 0;
  const llmOk = async () => { calls++; return { videoPrompt: prompt9.replace(/red dress/g, "blue coat"), startState: original.startState!.replace("red dress", "blue coat"), endState: original.endState!.replace("red dress", "blue coat"), openingState: null }; };
  const r1 = await rewriteSceneLook([anna, mark], original, null, llmOk);
  ok("first call hits the LLM and returns a cache", calls === 1 && !r1.fromCache && !!r1.cache && r1.cache.hash === h1 && r1.texts.videoPrompt.includes("blue coat"));
  const r2 = await rewriteSceneLook([anna, mark], original, r1.cache, llmOk);
  ok("matching hash reuses the cache without an LLM call", calls === 1 && r2.fromCache && r2.texts.videoPrompt === r1.texts.videoPrompt);
  const r3 = await rewriteSceneLook([{ ...anna, appearance: "blue coat" }, mark], original, r1.cache, llmOk);
  ok("changed appearance recomputes", calls === 2 && !r3.fromCache);
  const r4 = await rewriteSceneLook([anna, mark], original, null, async () => { throw new Error("boom"); });
  ok("LLM error → original text + warning, no cache", r4.texts === original && !!r4.warning && r4.cache === null);
  const r5 = await rewriteSceneLook([anna, mark], original, null, async () => ({ videoPrompt: "broken" }));
  ok("invalid LLM output → original text + warning", r5.texts === original && !!r5.warning);
  const r6 = await rewriteSceneLook([anna, mark], original, null, () => new Promise(() => {}), 30);
  ok("timeout → original text + warning", r6.texts === original && /timeout/.test(r6.warning ?? ""));
  const r7 = await rewriteSceneLook([{ ...anna, appearance: "" }], original, null, llmOk);
  ok("no appearance → no call, original text", r7.texts === original && calls === 2);

  // 4. Stage 50: individuals send ONLY the full body (front-face never sent); fallback to front when
  //    no full body; crowds front only; order character full-body → location → crowds.
  const scene = { id: "s1", number: 1, videoPrompt: prompt9, sceneKind: null, voiceover: null, dialogue: 'ANNA: "Now."', dialogueEn: 'ANNA: "Now."', language: "en", locationDesc: "Kitchen", continuesFrom: "new-sequence", startState: "", endState: "" };
  const loc = { id: "loc", name: "Kitchen", imageUrl: styledUrl("k-wide"), imageReverse: styledUrl("k-rev"), imageDetail: styledUrl("k-det"), imageExtra: null };
  const chars = [
    { characterId: "anna", name: "Anna", tier: "MAIN", imageFront: styledUrl("anna-front"), imageFull: styledUrl("anna-full"), appearance: anna.appearance, age: "34" },
    { characterId: "mark", name: "Mark", tier: "MAIN", imageFront: styledUrl("mark-front"), imageFull: null, appearance: mark.appearance, age: "40" },
    { characterId: "crowd", name: "Guests", tier: "CROWD", imageFront: styledUrl("crowd-front"), imageFull: styledUrl("crowd-full"), appearance: "party guests", age: null },
  ];
  const b = buildScenePrompt({ scene, characters: chars, location: loc, previous: null, provider: "seedance" });
  const urls = b.referenceImages;
  ok("Anna sends full body only (front never sent)", urls[0] === styledUrl("anna-full") && !urls.includes(styledUrl("anna-front")));
  ok("Mark falls back to front (no full body)", urls[1] === styledUrl("mark-front"));
  ok("crowd sends front only", urls.includes(styledUrl("crowd-front")) && !urls.includes(styledUrl("crowd-full")));
  ok("location refs follow character refs", urls[2] === styledUrl("k-wide"));
  ok("[Image1] Anna = full identity note", /\[Image1\] defines Anna: face, full-body build, proportions and current clothing/.test(b.prompt));
  ok("[Image2] Mark = face/identity fallback note", /\[Image2\] defines Mark's face and identity/.test(b.prompt));
  ok("crowd note unchanged", /defines the look of the group "Guests"/.test(b.prompt));

  // 5. Stage 50 cap trimming: one full-body ref per character never trimmed, crowds trimmed first
  const many = Array.from({ length: 14 }, (_, i) => ({ characterId: `c${i}`, name: `C${i}`, tier: "MAIN", imageFront: styledUrl(`c${i}-f`), imageFull: styledUrl(`c${i}-full`), appearance: "x", age: null }));
  const crowds = Array.from({ length: 10 }, (_, i) => ({ characterId: `g${i}`, name: `G${i}`, tier: "CROWD", imageFront: styledUrl(`g${i}`), appearance: "y", age: null }));
  const big = buildScenePrompt({ scene, characters: [...many, ...crowds], location: loc, previous: null, provider: "seedance" });
  ok("cap respected", big.referenceImages.length <= REFERENCE_IMAGE_CAP && REFERENCE_IMAGE_CAP === 30);
  ok("14 full-body character refs all kept, fronts never sent", many.every(c => big.referenceImages.includes(c.imageFull) && !big.referenceImages.includes(c.imageFront)));
  ok("crowds fit in the remaining room after 14 chars + 3 location angles", big.referenceImages.filter(u => u.includes("/g")).length === 10);

  // 6. look-neutral last-frame description
  ok("frame prompt forbids faces/hair/skin/build/clothing", /Do NOT describe people's faces, hair, skin, body build or clothing/.test(FRAME_STATE_SYSTEM_PROMPT) && !/clothing state/.test(FRAME_STATE_SYSTEM_PROMPT));

  // 7. SQL
  const sql = readFileSync("prisma/patch.sql", "utf8");
  ok("patch.sql adds Scene.lookCache", sql.includes('ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "lookCache" TEXT'));
  ok("patch.sql adds Scene.lookStale", sql.includes('ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "lookStale" BOOLEAN NOT NULL DEFAULT false'));
  console.log(`Stage 46B-1: ${n} checks passed`);
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
