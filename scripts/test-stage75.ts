/**
 * Stage 75 — pure unit checks for user-uploaded character photo references (no network, no DB).
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage75.ts
 */
import assert from "node:assert/strict";
import { parseUserRefs, mergeImageInput, USER_REFS_MAX, IMAGE_INPUT_CAP, USER_REF_MIME_EXT, USER_REF_MAX_BYTES } from "../lib/character-user-refs";

const H = "http" + "s://";
const url = (i: number) => `${H}bucket.s3.us-east-1.amazonaws.com/media/public/character-refs/c1/${i}.jpg`;
let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };

t("constants: max 4 user refs, image_input cap 10, jpeg/png/webp, 8 MB", () => {
  assert.equal(USER_REFS_MAX, 4);
  assert.equal(IMAGE_INPUT_CAP, 10);
  assert.deepEqual(Object.keys(USER_REF_MIME_EXT).sort(), ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(USER_REF_MAX_BYTES, 8 * 1024 * 1024);
});
t("parseUserRefs: null / empty / invalid JSON / non-array → []", () => {
  assert.deepEqual(parseUserRefs(null), []);
  assert.deepEqual(parseUserRefs(undefined), []);
  assert.deepEqual(parseUserRefs(""), []);
  assert.deepEqual(parseUserRefs("{not json"), []);
  assert.deepEqual(parseUserRefs('{"a":1}'), []);
  assert.deepEqual(parseUserRefs('"str"'), []);
});
t("parseUserRefs: keeps only http(s) strings, trims, dedupes", () => {
  const raw = JSON.stringify([url(1), " " + url(2) + " ", "ftp://x/y.jpg", "javascript:alert(1)", 42, null, "/relative.jpg", url(1), "http" + "://plain.example/p.png"]);
  assert.deepEqual(parseUserRefs(raw), [url(1), url(2), "http" + "://plain.example/p.png"]);
});
t("parseUserRefs: caps at 4", () => {
  const raw = JSON.stringify([url(1), url(2), url(3), url(4), url(5), url(6)]);
  const out = parseUserRefs(raw);
  assert.equal(out.length, 4);
  assert.deepEqual(out, [url(1), url(2), url(3), url(4)]);
});
t("mergeImageInput: user refs FIRST, then existing", () => {
  const anchor = `${H}cdn.example/anchor.png`;
  assert.deepEqual(mergeImageInput([url(1), url(2)], [anchor]), [url(1), url(2), anchor]);
  assert.deepEqual(mergeImageInput([], [anchor]), [anchor]);
  assert.deepEqual(mergeImageInput([url(1)], undefined), [url(1)]);
  assert.deepEqual(mergeImageInput([], []), []);
});
t("mergeImageInput: dedupes (existing already among user refs) and drops empties", () => {
  assert.deepEqual(mergeImageInput([url(1), url(2)], [url(2), "", "  "]), [url(1), url(2)]);
  assert.deepEqual(mergeImageInput([url(1), url(1)], [url(1)]), [url(1)]);
});
t("mergeImageInput: cap (default 10, custom)", () => {
  const many = Array.from({ length: 12 }, (_, i) => `${H}cdn.example/e-${i}.png`);
  const out = mergeImageInput([url(1)], many);
  assert.equal(out.length, 10);
  assert.equal(out[0], url(1));
  assert.equal(out[9], many[8]);
  const capped = mergeImageInput([url(1), url(2)], many, 3);
  assert.deepEqual(capped, [url(1), url(2), many[0]]);
  // ModelArk allows 14 — a higher cap passes more through.
  assert.equal(mergeImageInput([url(1)], many, 14).length, 13);
});
t("mergeImageInput: no user refs → identical to today's [ref] transport", () => {
  const ref = `${H}cdn.example/full.png`;
  assert.deepEqual(mergeImageInput(parseUserRefs(null), [ref], 10), [ref]);
  assert.equal(mergeImageInput(parseUserRefs(null), [], 10).length, 0, "no refs → not chained");
});

console.log(`\nStage 75: ${passed}/${passed} tests passed`);
