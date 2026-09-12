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

// 1. Stage 50: one individual with every photo (front, profile, full, extras) sends ONLY the full body.
const anna = {
  characterId: "anna", name: "Anna", tier: "MAIN", appearance: "red dress", age: "34",
  imageFront: styledUrl("anna-front"), imageProfile: styledUrl("anna-profile"), imageFull: styledUrl("anna-full"),
  imageExtra: JSON.stringify([styledUrl("anna-x0"), styledUrl("anna-x1")]),
};
{
  const b = build([anna]);
  const u = b.referenceImages;
  ok("only the full body is sent (front/profile/extras never sent)", u[0] === anna.imageFull && !u.includes(anna.imageFront) && !u.includes(anna.imageProfile) && !u.includes(styledUrl("anna-x0")) && !u.includes(styledUrl("anna-x1")));
  ok("location follows the single character ref", u[1] === loc.imageUrl && u[2] === loc.imageReverse && u[3] === loc.imageDetail && u.length === 4);
  ok("[Image1] full identity note", /\[Image1\] defines Anna: face, full-body build, proportions and current clothing; use the scene's staging and camera\./.test(b.prompt));
  ok("character ref has kind character", b.retryRefs[0].kind === "character");
  ok("characterIds diagnostics list Anna exactly once", (b.reference as any).characterIds.filter((id: string) => id === "anna").length === 1);
}

// 2. Crowd: front only, after the location (unchanged by Stage 50).
{
  const crowd = { characterId: "g", name: "Guests", tier: "CROWD", imageFront: styledUrl("g-front"), imageProfile: styledUrl("g-profile"), imageFull: styledUrl("g-full"), imageExtra: JSON.stringify([styledUrl("g-x0")]), appearance: "guests", age: null };
  const b = build([anna, crowd]);
  const u = b.referenceImages;
  ok("crowd sends front only", u.includes(styledUrl("g-front")) && !u.includes(styledUrl("g-profile")) && !u.includes(styledUrl("g-full")) && !u.includes(styledUrl("g-x0")));
  ok("crowd is last (after character + location)", u[u.length - 1] === styledUrl("g-front"));
}

// 3. Fallback + styled gating: full body preferred, fall back to the front, drop when neither is styled.
{
  const mark = { characterId: "mark", name: "Mark", tier: "MAIN", imageFront: styledUrl("m-front"), imageFull: styledUrl("m-full"), appearance: "suit", age: "40" };
  const b = build([mark]);
  ok("full body preferred over front", b.referenceImages[0] === mark.imageFull && !b.referenceImages.includes(mark.imageFront) && b.referenceImages[1] === loc.imageUrl);
  const bare = build([{ characterId: "z", name: "Zed", tier: "MAIN", imageFront: styledUrl("z-front"), appearance: "x", age: null }], null);
  ok("no full body, front only, no location → single fallback ref", bare.referenceImages.length === 1 && bare.referenceImages[0] === styledUrl("z-front"));
  ok("fallback front uses the face/identity note", /\[Image1\] defines Zed's face and identity/.test(bare.prompt));
  const proto = "htt" + "ps:/" + "/"; // avoid a bare literal; RAW_URL is deliberately NOT a styled asset
  const RAW_URL = `${proto}unstyled.example/raw.png`;
  const unstyledFull = build([{ ...mark, imageFull: RAW_URL }]);
  ok("unstyled full body ignored → falls back to the styled front", unstyledFull.referenceImages[0] === mark.imageFront && !unstyledFull.referenceImages.includes(RAW_URL));
  const noneStyled = build([{ characterId: "u", name: "U", tier: "MAIN", imageFront: RAW_URL, imageFull: RAW_URL, appearance: "x", age: null }], null);
  ok("no styled photo at all → character dropped (zero refs)", noneStyled.referenceImages.length === 0);
}

// 4. Stage 50 trimming: one full-body ref per character, base location angles kept; room fills location
//    extras → crowds; trim order crowds → location extras. Full-body refs never trimmed until the cap itself.
{
  const ind = (i: number) => ({
    characterId: `c${i}`, name: `C${i}`, tier: "MAIN", appearance: "x", age: null,
    imageFront: styledUrl(`c${i}-f`), imageProfile: styledUrl(`c${i}-p`), imageFull: styledUrl(`c${i}-full`),
    imageExtra: JSON.stringify([styledUrl(`c${i}-x0`)]),
  });
  const crowds = Array.from({ length: 4 }, (_, i) => ({ characterId: `g${i}`, name: `G${i}`, tier: "CROWD", imageFront: styledUrl(`g${i}`), appearance: "y", age: null }));
  const locWithExtras = { ...loc, imageExtra: JSON.stringify([styledUrl("k-x0"), styledUrl("k-x1"), styledUrl("k-x2")]) };

  // A: 20 chars + 3 base location = 23; room 7 → 3 location extras + 4 crowds.
  const many20 = Array.from({ length: 20 }, (_, i) => ind(i));
  const a = build([...many20, ...crowds], locWithExtras).referenceImages;
  ok("A: cap respected", a.length === 30);
  ok("A: only full-body char refs (no front/profile/extra)", many20.every(c => a.includes(c.imageFull) && !a.includes(c.imageFront) && !a.includes(c.imageProfile)) && !a.some(x => /c\d+-x\d/.test(x)));
  ok("A: base location angles kept", a.includes(loc.imageUrl) && a.includes(loc.imageReverse) && a.includes(loc.imageDetail));
  ok("A: location extras kept", a.filter(x => /k-x\d/.test(x)).length === 3);
  ok("A: all 4 crowds fit", a.filter(x => /\/g\d\.jpg$/.test(x)).length === 4);
  ok("A: order chars → location base → location extras → crowds", a[0] === styledUrl("c0-full") && a[20] === loc.imageUrl && a[23] === styledUrl("k-x0") && a[26] === styledUrl("g0"));

  // B: 26 chars + 3 base = 29; room 1 → 1 location extra, 0 crowds (crowds trimmed before location extras).
  const many26 = Array.from({ length: 26 }, (_, i) => ind(i));
  const bR = build([...many26, ...crowds], locWithExtras).referenceImages;
  ok("B: cap respected", bR.length === 30);
  ok("B: all 26 full-body refs kept", many26.every(c => bR.includes(c.imageFull)));
  ok("B: crowds trimmed before location extras", !bR.some(x => /\/g\d\.jpg$/.test(x)) && bR.filter(x => /k-x\d/.test(x)).length === 1);

  // C: 31 chars alone exceed the cap → 30 full-body refs, no room for location or crowds.
  const many31 = Array.from({ length: 31 }, (_, i) => ind(i));
  const cR = build([...many31, ...crowds], locWithExtras).referenceImages;
  ok("C: cap respected, char full-body refs fill it", cR.length === 30 && cR.every(x => /c\d+-full/.test(x)));
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
