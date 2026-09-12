/** Stage 46B-2 unit tests (no live API): all character photos as Seedance references (order + trimming), shot route body schemas. */
import assert from "node:assert";
import { buildScenePrompt, REFERENCE_IMAGE_CAP } from "../lib/scene-prompt";
import { VISUAL_STYLE_ID } from "../lib/visual-style";
import { characterShotSchema, locationShotSchema } from "../lib/validations";

let n = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); n++; };

const styledUrl = (k: string) => `https://cdn.example.com/public/references/p1/${VISUAL_STYLE_ID}/${k}.jpg`;
const scene = { id: "s1", number: 1, videoPrompt: "[CHARACTER]: Anna. [ACTION]: talks.", sceneKind: null, voiceover: null, dialogue: 'ANNA: "Now."', dialogueEn: 'ANNA: "Now."', language: "en", locationDesc: "Kitchen", continuesFrom: "new-sequence", startState: "", endState: "" };
const loc = { id: "loc", name: "Kitchen", imageUrl: styledUrl("k-wide"), imageReverse: styledUrl("k-rev"), imageDetail: styledUrl("k-det"), imageExtra: null };
const build = (characters: any[], location: any = loc) => buildScenePrompt({ scene, characters, location, previous: null, provider: "seedance" });

// 1. One individual with all 5 photos: front, profile, full, extra1, extra2, then the location.
const anna = {
  characterId: "anna", name: "Anna", tier: "MAIN", appearance: "red dress", age: "34",
  imageFront: styledUrl("anna-front"), imageProfile: styledUrl("anna-profile"), imageFull: styledUrl("anna-full"),
  imageExtra: JSON.stringify([styledUrl("anna-x0"), styledUrl("anna-x1")]),
};
{
  const b = build([anna]);
  const u = b.referenceImages;
  ok("order: front, profile, full, extra1, extra2", u[0] === anna.imageFront && u[1] === anna.imageProfile && u[2] === anna.imageFull && u[3] === styledUrl("anna-x0") && u[4] === styledUrl("anna-x1"));
  ok("location follows all character photos", u[5] === loc.imageUrl && u[6] === loc.imageReverse && u[7] === loc.imageDetail && u.length === 8);
  ok("[Image1] face note", /\[Image1\] defines Anna's face and identity; use the scene's staging and camera\./.test(b.prompt));
  ok("[Image2] profile note", /\[Image2\] defines Anna's profile \/ side view of the same face and hair\./.test(b.prompt));
  ok("[Image3] full-body note", /\[Image3\] defines Anna's full-body build, proportions and current clothing\./.test(b.prompt));
  ok("[Image4]/[Image5] extra notes", /\[Image4\] another angle of Anna \(same person, same clothing\)\./.test(b.prompt) && /\[Image5\] another angle of Anna/.test(b.prompt));
  ok("all character refs have kind character", b.retryRefs.slice(0, 5).every(r => r.kind === "character"));
  ok("characterIds diagnostics list Anna for every photo", (b.reference as any).characterIds.filter((id: string) => id === "anna").length === 5);
}

// 2. Crowd: front only, after the location.
{
  const crowd = { characterId: "g", name: "Guests", tier: "CROWD", imageFront: styledUrl("g-front"), imageProfile: styledUrl("g-profile"), imageFull: styledUrl("g-full"), imageExtra: JSON.stringify([styledUrl("g-x0")]), appearance: "guests", age: null };
  const b = build([anna, crowd]);
  const u = b.referenceImages;
  ok("crowd sends front only", u.includes(styledUrl("g-front")) && !u.includes(styledUrl("g-profile")) && !u.includes(styledUrl("g-full")) && !u.includes(styledUrl("g-x0")));
  ok("crowd is last (after location)", u[u.length - 1] === styledUrl("g-front"));
}

// 3. Missing profile / extras still works (front, full, location).
{
  const mark = { characterId: "mark", name: "Mark", tier: "MAIN", imageFront: styledUrl("m-front"), imageFull: styledUrl("m-full"), appearance: "suit", age: "40" };
  const b = build([mark]);
  ok("no profile/extras → front, full, then location", b.referenceImages[0] === mark.imageFront && b.referenceImages[1] === mark.imageFull && b.referenceImages[2] === loc.imageUrl);
  const bare = build([{ characterId: "z", name: "Zed", tier: "MAIN", imageFront: styledUrl("z-front"), appearance: "x", age: null }], null);
  ok("front only, no location → single ref", bare.referenceImages.length === 1 && bare.referenceImages[0] === styledUrl("z-front"));
  const RAW_URL = "https://" + "unstyled.example" + "/raw.png"; // not a styled asset → must be ignored
  const unstyledExtra = build([{ ...mark, imageExtra: JSON.stringify([RAW_URL]) }]);
  ok("unstyled extra is ignored", !unstyledExtra.referenceImages.includes(RAW_URL));
  const brokenExtra = build([{ ...mark, imageExtra: "not json" }]);
  ok("broken imageExtra JSON is ignored", brokenExtra.referenceImages.length === 5);
}

// 4. Trimming over the cap: crowds → extra location angles → character extras → character profiles; face + full never trimmed.
{
  // 8 individuals × (front, profile, full, 2 extras) = 40 refs alone: 16 mandatory (face+full), 8 profiles, 16 extras.
  const many = Array.from({ length: 8 }, (_, i) => ({
    characterId: `c${i}`, name: `C${i}`, tier: "MAIN", appearance: "x", age: null,
    imageFront: styledUrl(`c${i}-f`), imageProfile: styledUrl(`c${i}-p`), imageFull: styledUrl(`c${i}-full`),
    imageExtra: JSON.stringify([styledUrl(`c${i}-x0`), styledUrl(`c${i}-x1`)]),
  }));
  const crowds = Array.from({ length: 4 }, (_, i) => ({ characterId: `g${i}`, name: `G${i}`, tier: "CROWD", imageFront: styledUrl(`g${i}`), appearance: "y", age: null }));
  const locWithExtras = { ...loc, imageExtra: JSON.stringify([styledUrl("k-x0"), styledUrl("k-x1"), styledUrl("k-x2")]) };
  const big = build([...many, ...crowds], locWithExtras);
  const u = big.referenceImages;
  ok("cap respected", u.length === REFERENCE_IMAGE_CAP && REFERENCE_IMAGE_CAP === 30);
  ok("face + full never trimmed", many.every(c => u.includes(c.imageFront) && u.includes(c.imageFull)));
  ok("base location angles kept", u.includes(loc.imageUrl) && u.includes(loc.imageReverse) && u.includes(loc.imageDetail));
  ok("all profiles kept before extras", many.every(c => u.includes(c.imageProfile)));
  // 16 + 3 + 8 = 27 → room 3 → 3 character extras, 0 location extras, 0 crowds
  ok("character extras partially kept (3)", u.filter(x => /c\d-x\d/.test(x)).length === 3);
  ok("extra location angles trimmed before character extras", !u.some(x => /k-x\d/.test(x)));
  ok("crowds trimmed first", !u.some(x => /\/g\d\.jpg$/.test(x)));
  ok("per-character order kept: front, profile, full, extras", u[0] === styledUrl("c0-f") && u[1] === styledUrl("c0-p") && u[2] === styledUrl("c0-full") && u[3] === styledUrl("c0-x0") && u[4] === styledUrl("c0-x1") && u[5] === styledUrl("c1-f"));

  // Tighter: 12 individuals × (face+full) = 24 mandatory + 3 base location = 27 → room 3 → profiles first.
  const twelve = Array.from({ length: 12 }, (_, i) => ({ ...many[0], characterId: `d${i}`, name: `D${i}`, imageFront: styledUrl(`d${i}-f`), imageProfile: styledUrl(`d${i}-p`), imageFull: styledUrl(`d${i}-full`) }));
  const tight = build([...twelve, ...crowds], locWithExtras);
  const t = tight.referenceImages;
  ok("tight: cap respected", t.length === 30);
  ok("tight: 3 profiles kept, no extras, no location extras, no crowds", t.filter(x => /d\d+-p/.test(x)).length === 3 && !t.some(x => /-x\d/.test(x)) && !t.some(x => /\/g\d\.jpg$/.test(x)));

  // Room for everything but crowds: 2 individuals → 10 refs + 3 base + 3 loc extras = 16, crowds fill the rest.
  const small = build([many[0], many[1], ...crowds], locWithExtras);
  const s = small.referenceImages;
  ok("small set: everything kept incl. location extras and crowds", s.length === 20 && s.filter(x => /k-x\d/.test(x)).length === 3 && s.filter(x => /\/g\d\.jpg$/.test(x)).length === 4);
  ok("small set order: characters, location (base then extras), crowds", s[10] === loc.imageUrl && s[13] === styledUrl("k-x0") && s[16] === styledUrl("g0"));
}

// 5. Route body schemas.
ok("characterShotSchema accepts front", characterShotSchema.safeParse({ shot: "front" }).success);
ok("characterShotSchema accepts extra with index", characterShotSchema.safeParse({ shot: "extra", index: 1, imageModel: "flux" }).success);
ok("characterShotSchema rejects unknown shot", !characterShotSchema.safeParse({ shot: "back" }).success);
ok("characterShotSchema rejects negative / fractional index", !characterShotSchema.safeParse({ shot: "extra", index: -1 }).success && !characterShotSchema.safeParse({ shot: "extra", index: 1.5 }).success);
ok("characterShotSchema rejects missing shot", !characterShotSchema.safeParse({}).success);
ok("locationShotSchema accepts master/reverse/detail/extra", ["master", "reverse", "detail"].every(slot => locationShotSchema.safeParse({ slot }).success) && locationShotSchema.safeParse({ slot: "extra", index: 0 }).success);
ok("locationShotSchema rejects unknown slot / string index", !locationShotSchema.safeParse({ slot: "wide" }).success && !locationShotSchema.safeParse({ slot: "extra", index: "0" }).success);

console.log(`Stage 46B-2: ${n} checks passed`);
