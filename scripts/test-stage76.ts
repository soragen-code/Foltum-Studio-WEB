/**
 * Stage 76 — pure unit checks for the dashboard project cover picker (no network, no DB).
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage76.ts
 */
import assert from "node:assert/strict";
import { pickProjectCover } from "../lib/project-cover";

const H = "http" + "s://";
const img = (name: string) => `${H}cdn.example.com/locations/${name}.jpg`;
let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };

t("picks the lowest-numbered season and episode #1's location image", () => {
  const seasons = [
    { number: 2, episodes: [{ number: 1, location: { imageUrl: img("s2e1") } }] },
    { number: 1, episodes: [
      { number: 3, location: { imageUrl: img("s1e3") } },
      { number: 1, location: { imageUrl: img("s1e1") } },
      { number: 2, location: { imageUrl: img("s1e2") } },
    ] },
  ];
  assert.equal(pickProjectCover(seasons), img("s1e1"));
});

t("falls back to the next episode with an image inside the first season only", () => {
  const seasons = [
    { number: 1, episodes: [
      { number: 1, location: null },
      { number: 2, location: { imageUrl: null } },
      { number: 3, location: { imageUrl: img("s1e3") } },
    ] },
    { number: 2, episodes: [{ number: 1, location: { imageUrl: img("s2e1") } }] },
  ];
  assert.equal(pickProjectCover(seasons), img("s1e3"));
  // First season has no images at all → null even though season 2 has one.
  const noneInFirst = [
    { number: 1, episodes: [{ number: 1, location: null }] },
    { number: 2, episodes: [{ number: 1, location: { imageUrl: img("s2e1") } }] },
  ];
  assert.equal(pickProjectCover(noneInFirst), null);
});

t("returns null when there are no images / no episodes / no seasons", () => {
  assert.equal(pickProjectCover([]), null);
  assert.equal(pickProjectCover(null), null);
  assert.equal(pickProjectCover(undefined), null);
  assert.equal(pickProjectCover([{ number: 1, episodes: [] }]), null);
  assert.equal(pickProjectCover([{ number: 1, episodes: [{ number: 1, location: { imageUrl: null } }, { number: 2 }] }]), null);
});

t("ignores non-http values (relative paths, data:, javascript:, empty, non-string)", () => {
  const seasons = [
    { number: 1, episodes: [
      { number: 1, location: { imageUrl: "/relative/path.jpg" } },
      { number: 2, location: { imageUrl: "data:image/png;base64,AAAA" } },
      { number: 3, location: { imageUrl: "javascript:alert(1)" } },
      { number: 4, location: { imageUrl: "   " } },
      { number: 5, location: { imageUrl: 42 as unknown as string } },
      { number: 6, location: { imageUrl: "  " + "http" + "://plain.example/p.png " } },
    ] },
  ];
  assert.equal(pickProjectCover(seasons), "http" + "://plain.example/p.png");
  const onlyBad = [{ number: 1, episodes: [{ number: 1, location: { imageUrl: "ftp://x/y.jpg" } }] }];
  assert.equal(pickProjectCover(onlyBad), null);
});

t("season ordering falls back to createdAt when number is missing; numbered seasons win over unnumbered", () => {
  const byDate = [
    { createdAt: "2026-03-02T00:00:00Z", episodes: [{ number: 1, location: { imageUrl: img("later") } }] },
    { createdAt: new Date("2026-03-01T00:00:00Z"), episodes: [{ number: 1, location: { imageUrl: img("earlier") } }] },
  ];
  assert.equal(pickProjectCover(byDate), img("earlier"));
  const mixed = [
    { number: null, createdAt: "2026-01-01T00:00:00Z", episodes: [{ number: 1, location: { imageUrl: img("unnumbered") } }] },
    { number: 1, createdAt: "2026-06-01T00:00:00Z", episodes: [{ number: 1, location: { imageUrl: img("numbered") } }] },
  ];
  assert.equal(pickProjectCover(mixed), img("numbered"));
  // Input arrays are not mutated.
  const input = [{ number: 2, episodes: [{ number: 2, location: { imageUrl: img("b") } }, { number: 1, location: { imageUrl: img("a") } }] }, { number: 1, episodes: [] }];
  pickProjectCover(input);
  assert.equal(input[0].number, 2);
  assert.equal(input[0].episodes[0].number, 2);
});

console.log(`\nStage 76: ${passed}/5 tests passed`);
