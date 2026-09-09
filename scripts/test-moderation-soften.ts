import { test } from "node:test";
import assert from "node:assert/strict";
import { softenForModeration, moderationHints } from "../lib/sanitize-prompt";

const PROMPT = `[SHOT TYPE]: 0–8s medium two-shot → 8–16s over-the-shoulder on Eric
[LIGHTING]: golden hour, warm side light
[BLOCKING]: Eric и Lilian стоят у лодки
[GAZE]: they look at each other
[NON-VERBAL]: Eric сжимает челюсти, Lilian angry
[ACTION]: Eric делает резкое движение рукой, grabs the rope
[CHARACTER]: Eric, 34, dark hair
[TRANSITION]: hard cut
Eric says in English, angry, lips moving on camera: "I had no choice, Lilian!"
Lilian says in English, desperate, lips moving on camera: "You sold the boat?"
PERFORMANCE: emotional accents (rising anger, cracking voice, bitter laugh).`;

test("level 1 neutralizes explicit content and keeps ordinary text", () => {
  const r = softenForModeration('He pulls a gun, blood on the floor, the child is drowning. She smiles at the harbour.', 1);
  assert.equal(r.changed, true);
  assert.doesNotMatch(r.text, /gun|blood|drowning/i);
  assert.match(r.text, /She smiles at the harbour\./);
  const clean = softenForModeration("Two friends talk on a sunny beach about the future.", 1);
  assert.equal(clean.changed, false);
  assert.equal(clean.text, "Two friends talk on a sunny beach about the future.");
});

test("level 1 leaves aggression cues in place; level 2 softens them (EN + RU)", () => {
  const l1 = softenForModeration(PROMPT, 1);
  assert.match(l1.text, /angry/);
  const l2 = softenForModeration(PROMPT, 2);
  assert.doesNotMatch(l2.text, /\bangry\b|grabs|резкое движение|сжимает челюсти|rising anger|desperate/i);
  assert.match(l2.text, /emotional nuance, a catch in the voice, a quiet laugh/);
  // Spoken lines are never rewritten except for flagged words; the quotes stay intact.
  assert.match(l2.text, /"I had no choice, Lilian!"/);
});

test("level 3 rewrites staging lines and strips delivery cues, keeps other tags", () => {
  const l3 = softenForModeration(PROMPT, 3);
  assert.match(l3.text, /^\[ACTION\]: the characters talk to each other/m);
  assert.match(l3.text, /^\[NON-VERBAL\]: attentive expressive faces/m);
  assert.match(l3.text, /^\[BLOCKING\]: the characters stand a step apart/m);
  assert.match(l3.text, /Eric says in English lips moving on camera: "I had no choice, Lilian!"/);
  assert.match(l3.text, /Lilian says in English lips moving on camera: "You sold the boat\?"/);
  assert.match(l3.text, /^\[CHARACTER\]: Eric, 34, dark hair$/m);
  assert.match(l3.text, /^\[LIGHTING\]: golden hour, warm side light$/m);
});

test("softening is idempotent", () => {
  const once = softenForModeration(PROMPT, 3).text;
  const twice = softenForModeration(once, 3);
  assert.equal(twice.text, once);
});

test("moderationHints lists the flagged phrases from the original scene text", () => {
  const hints = moderationHints(PROMPT);
  assert.ok(hints.length > 0 && hints.length <= 6);
  assert.ok(hints.some(h => /angry/i.test(h)));
  assert.ok(hints.some(h => /резкое движение/i.test(h)));
  assert.deepEqual(moderationHints("A calm talk by the sea."), []);
});
