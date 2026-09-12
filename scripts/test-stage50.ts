/**
 * Stage 50 — unit tests (no live API) for the character VIDEO reference set: each individual sends
 * EXACTLY ONE photo, the styled FULL-BODY photo (imageFull). The front-face portrait (which trips
 * Seedance moderation E005 — see scripts/_exp/stage48-results.json), the profile and the extra angles
 * are NEVER sent to video. Fallback: a character with no styled full body sends its front. Crowds are
 * unchanged (front only). Order: character full-body refs → location base angles → location extra
 * angles → crowds. REFERENCE_IMAGE_CAP respected; trim order crowds → location extras.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage50.ts
 */
import assert from "node:assert";
import { buildScenePrompt, REFERENCE_IMAGE_CAP } from "../lib/scene-prompt";
import { VISUAL_STYLE_ID } from "../lib/visual-style";

let n = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); n++; };

const proto = "htt" + "ps:/" + "/"; // build URLs without a bare literal (avoids editor autolinking)
const styledUrl = (k: string) => `${proto}cdn.example.com/public/references/p1/${VISUAL_STYLE_ID}/${k}.jpg`;
const rawUrl = (k: string) => `${proto}unstyled.example/${k}.png`;

const scene = { id: "s1", number: 1, videoPrompt: "[CHARACTER]: Anna. [ACTION]: talks.", sceneKind: null, voiceover: null, dialogue: 'ANNA: "Now."', dialogueEn: 'ANNA: "Now."', language: "en", locationDesc: "Kitchen", continuesFrom: "new-sequence", startState: "", endState: "" };
const loc = { id: "loc", name: "Kitchen", imageUrl: styledUrl("k-wide"), imageReverse: styledUrl("k-rev"), imageDetail: styledUrl("k-det"), imageExtra: null };
const build = (characters: any[], location: any = loc) => buildScenePrompt({ scene, characters, location, previous: null, provider: "seedance" });

// 1. An individual with front + profile + full + extras sends ONLY the full body.
{
  const anna = {
    characterId: "anna", name: "Anna", tier: "MAIN", appearance: "red dress", age: "34",
    imageFront: styledUrl("anna-front"), imageProfile: styledUrl("anna-profile"), imageFull: styledUrl("anna-full"),
    imageExtra: JSON.stringify([styledUrl("anna-x0"), styledUrl("anna-x1")]),
  };
  const b = build([anna]);
  const u = b.referenceImages;
  ok("individual: only the full body is sent", u[0] === styledUrl("anna-full"));
  ok("individual: front-face portrait never sent", !u.includes(styledUrl("anna-front")));
  ok("individual: profile never sent", !u.includes(styledUrl("anna-profile")));
  ok("individual: extra angles never sent", !u.includes(styledUrl("anna-x0")) && !u.includes(styledUrl("anna-x1")));
  ok("individual: exactly one character ref", b.retryRefs.filter(r => r.kind === "character").length === 1);
  ok("individual: full identity note", /\[Image1\] defines Anna: face, full-body build, proportions and current clothing; use the scene's staging and camera\./.test(b.prompt));
  ok("individual: location follows the single character ref", u[1] === loc.imageUrl && u.length === 4);
}

// 2. Fallback: an individual with no styled full body sends its front, with the face/identity note.
{
  const oldChar = { characterId: "mark", name: "Mark", tier: "MAIN", imageFront: styledUrl("mark-front"), imageFull: null, appearance: "suit", age: "40" };
  const b = build([oldChar]);
  ok("fallback: front sent when no full body", b.referenceImages[0] === styledUrl("mark-front") && !b.referenceImages.includes(styledUrl("mark-full")));
  ok("fallback: face/identity note (not the full-body note)", /\[Image1\] defines Mark's face and identity; use the scene's staging and camera\./.test(b.prompt) && !/defines Mark: face, full-body build/.test(b.prompt));
  // Full body preferred whenever present.
  const both = { ...oldChar, imageFull: styledUrl("mark-full") };
  const b2 = build([both]);
  ok("fallback: full body preferred over front when both exist", b2.referenceImages[0] === styledUrl("mark-full") && !b2.referenceImages.includes(styledUrl("mark-front")));
  // Unstyled full body is ignored, so it falls back to the styled front.
  const unstyled = { ...oldChar, imageFull: rawUrl("mark-full") };
  const b3 = build([unstyled]);
  ok("fallback: unstyled full body ignored → styled front", b3.referenceImages[0] === styledUrl("mark-front") && !b3.referenceImages.includes(rawUrl("mark-full")));
  // No styled photo at all → the character is dropped.
  const none = { characterId: "u", name: "U", tier: "MAIN", imageFront: rawUrl("u-f"), imageFull: rawUrl("u-full"), appearance: "x", age: null };
  const b4 = build([none], null);
  ok("fallback: no styled photo → character dropped (zero refs)", b4.referenceImages.length === 0);
}

// 3. Crowds are unchanged (front only), even though the crowd carries a full-body photo.
{
  const anna = { characterId: "anna", name: "Anna", tier: "MAIN", imageFront: styledUrl("anna-front"), imageFull: styledUrl("anna-full"), appearance: "x", age: null };
  const crowd = { characterId: "g", name: "Guests", tier: "CROWD", imageFront: styledUrl("g-front"), imageProfile: styledUrl("g-profile"), imageFull: styledUrl("g-full"), imageExtra: JSON.stringify([styledUrl("g-x0")]), appearance: "guests", age: null };
  const b = build([anna, crowd]);
  const u = b.referenceImages;
  ok("crowd: front only", u.includes(styledUrl("g-front")) && !u.includes(styledUrl("g-full")) && !u.includes(styledUrl("g-profile")) && !u.includes(styledUrl("g-x0")));
  ok("crowd: comes last, after the character full body and the location", u[u.length - 1] === styledUrl("g-front") && u[0] === styledUrl("anna-full"));
  ok("crowd note unchanged", /defines the look of the group "Guests" \(extras\)/.test(b.prompt));
}

// 4. Order: character full-body → location base → location extras → crowds.
{
  const chars = [
    { characterId: "a", name: "A", tier: "MAIN", imageFront: styledUrl("a-f"), imageFull: styledUrl("a-full"), appearance: "x", age: null },
    { characterId: "b", name: "B", tier: "MAIN", imageFront: styledUrl("b-f"), imageFull: styledUrl("b-full"), appearance: "x", age: null },
  ];
  const crowds = [{ characterId: "g0", name: "G0", tier: "CROWD", imageFront: styledUrl("g0"), appearance: "y", age: null }];
  const locWithExtras = { ...loc, imageExtra: JSON.stringify([styledUrl("k-x0"), styledUrl("k-x1")]) };
  const u = build([...chars, ...crowds], locWithExtras).referenceImages;
  ok("order: char full-body refs first", u[0] === styledUrl("a-full") && u[1] === styledUrl("b-full"));
  ok("order: location base angles next", u[2] === loc.imageUrl && u[3] === loc.imageReverse && u[4] === loc.imageDetail);
  ok("order: location extras after base angles", u[5] === styledUrl("k-x0") && u[6] === styledUrl("k-x1"));
  ok("order: crowds last", u[7] === styledUrl("g0") && u.length === 8);
}

// 5. Cap respected; trim order crowds → location extras; full-body refs never trimmed until the cap.
{
  const ind = (i: number) => ({ characterId: `c${i}`, name: `C${i}`, tier: "MAIN", imageFront: styledUrl(`c${i}-f`), imageFull: styledUrl(`c${i}-full`), appearance: "x", age: null });
  const crowds = Array.from({ length: 5 }, (_, i) => ({ characterId: `g${i}`, name: `G${i}`, tier: "CROWD", imageFront: styledUrl(`g${i}`), appearance: "y", age: null }));
  const locWithExtras = { ...loc, imageExtra: JSON.stringify([styledUrl("k-x0"), styledUrl("k-x1"), styledUrl("k-x2")]) };

  // 26 chars + 3 base location = 29; room 1 → 1 location extra, 0 crowds (crowds trimmed first).
  const many26 = Array.from({ length: 26 }, (_, i) => ind(i));
  const t = build([...many26, ...crowds], locWithExtras).referenceImages;
  ok("cap: respected", t.length === REFERENCE_IMAGE_CAP && REFERENCE_IMAGE_CAP === 30);
  ok("cap: all 26 full-body refs kept", many26.every(c => t.includes(styledUrl(`${c.characterId}-full`))));
  ok("cap: base location angles kept", t.includes(loc.imageUrl) && t.includes(loc.imageReverse) && t.includes(loc.imageDetail));
  ok("cap: crowds trimmed before location extras", !t.some(x => /\/g\d\.jpg$/.test(x)) && t.filter(x => /k-x\d/.test(x)).length === 1);

  // 31 chars alone exceed the cap → 30 full-body refs, no room for location or crowds.
  const many31 = Array.from({ length: 31 }, (_, i) => ind(i));
  const c = build([...many31, ...crowds], locWithExtras).referenceImages;
  ok("cap: char full-body refs fill the cap when they exceed it", c.length === 30 && c.every(x => /c\d+-full/.test(x)));
}

console.log(`Stage 50: ${n} checks passed`);
