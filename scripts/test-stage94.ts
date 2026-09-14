/**
 * Stage 94 checks (pure, static + a live import of lib/season.ts — no network / DB / render):
 *
 *   The author asked for LOCATION generation that is more detailed, atmospheric and deep,
 *   with FULL IMMERSION, and where OPEN-AIR locations UNDER THE SKY predominate so the world
 *   feels bigger.
 *
 *   Change A — lib/idea.ts LOCATION_FIELD_RULES (embedded into every location-writing system
 *     prompt) now demands a richer, deeply atmospheric visualPrompt (4-6 sentences) with real
 *     depth toward a visible horizon, environmental atmosphere and full immersion, and adds a
 *     strong directive that OPEN-AIR EXTERIORS UNDER THE SKY must PREDOMINATE — while still
 *     keeping the set diverse and the existing field/format/originality rules.
 *
 *   Change B — lib/season.ts locationReviseSystemPrompt(...) enriches the locationDesc guidance
 *     with the same atmospheric / depth / open-under-the-sky language, WITHOUT touching the JSON
 *     schema, per-scene rules or the 9-line videoPrompt structure.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage94.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

const IDEA = "lib/idea.ts";
const SEASON = "lib/season.ts";

const idea = readFileSync(IDEA, "utf8");
const season = readFileSync(SEASON, "utf8");

// Isolate the LOCATION_FIELD_RULES template literal from lib/idea.ts
const rulesStart = idea.indexOf("const LOCATION_FIELD_RULES = `");
ok(rulesStart >= 0, "A: lib/idea.ts still defines LOCATION_FIELD_RULES");
const rulesEnd = idea.indexOf("`;", rulesStart);
ok(rulesEnd > rulesStart, "A: LOCATION_FIELD_RULES template literal is closed");
const rules = idea.slice(rulesStart, rulesEnd);

// ── A. LOCATION_FIELD_RULES: existing structure kept ──
{
  ok(/"name":/.test(rules), "A: LOCATION_FIELD_RULES keeps the \"name\" field");
  ok(/"description":/.test(rules), "A: LOCATION_FIELD_RULES keeps the \"description\" field");
  ok(/"visualPrompt":/.test(rules), "A: LOCATION_FIELD_RULES keeps the \"visualPrompt\" field");
  ok(/ALWAYS in ENGLISH/.test(rules), "A: visualPrompt is still ALWAYS in ENGLISH");
  ok(/NO PEOPLE/.test(rules) && /no text\/logos/.test(rules), "A: still forbids people and text/logos");
  ok(/ORIGINAL/.test(rules), "A: still requires ORIGINAL locations (no real landmarks/brands)");
  ok(/9:16/.test(rules), "A: still targets a vertical 9:16 reference photograph");
  ok(/DIVERSE|diverse|vary/.test(rules), "A: still keeps the set diverse / varied");
}

// ── A. LOCATION_FIELD_RULES: new richer / atmospheric / immersive directives ──
{
  ok(/open[- ]air|under the sky|open sky|open-sky/i.test(rules), "A: requires open-air / under-the-sky locations");
  ok(/horizon/i.test(rules), "A: requires a visible horizon");
  ok(/predominate|majority|most\b|outdoor|exterior/i.test(rules), "A: open exteriors must predominate / be the majority");
  ok(/atmospher/i.test(rules), "A: demands atmospheric rendering");
  ok(/immers|depth|scale/i.test(rules), "A: demands immersion / depth / scale");
  ok(/foreground/i.test(rules) && /mid-?ground/i.test(rules), "A: keeps explicit foreground/mid-ground depth staging");
  ok(/sky/i.test(rules), "A: sky is explicitly part of the frame");
  // visualPrompt is now longer (4-6 sentences)
  ok(/4-6 sentences|4–6 sentences/.test(rules), "A: visualPrompt expanded to 4-6 sentences");
  // description also nudged toward openness / atmosphere
  const descLine = rules.split("\n").find((l) => l.includes('"description":')) ?? "";
  ok(/OPENNESS|openness|ATMOSPHERE|atmosphere|sky|scale|SCALE/.test(descLine), "A: description conveys openness / atmosphere / scale too");
}

// ── B. locationReviseSystemPrompt: schema & rules untouched, guidance enriched ──
{
  const fnStart = season.indexOf("export function locationReviseSystemPrompt");
  ok(fnStart >= 0, "B: lib/season.ts still defines locationReviseSystemPrompt");
  const fnEnd = season.indexOf("\n}", fnStart);
  const fn = season.slice(fnStart, fnEnd);

  // schema / structural rules kept
  ok(/"locationName": string/.test(fn), "B: keeps locationName in the JSON schema");
  ok(/"locationDesc": string/.test(fn), "B: keeps locationDesc in the JSON schema");
  ok(/"scenes":/.test(fn), "B: keeps the scenes array in the JSON schema");
  ok(/\[SHOT TYPE\]\/\[VISUAL STYLE\]\/\[LIGHTING\]\/\[BLOCKING\]\/\[GAZE\]\/\[NON-VERBAL\]\/\[ACTION\]\/\[CHARACTER\]\/\[TRANSITION\]/.test(fn), "B: keeps the exact 9-line videoPrompt structure");
  ok(/\[VISUAL STYLE\] stays identical/.test(fn), "B: keeps [VISUAL STYLE] stays identical rule");
  ok(/Return ALL scenes/.test(fn), "B: keeps 'Return ALL scenes' rule");
  ok(/Never add spoken text/.test(fn), "B: keeps 'Never add spoken text' rule");
  ok(/Original content only/.test(fn), "B: keeps 'Original content only' rule");
  ok(/combat choreography/.test(fn), "B: keeps the action/fight choreography rule");

  // enriched locationDesc guidance
  ok(/atmospher/i.test(fn), "B: locationDesc guidance now demands atmospheric description");
  ok(/horizon/i.test(fn), "B: locationDesc guidance references a horizon");
  ok(/depth|foreground|mid-?ground|scale/i.test(fn), "B: locationDesc guidance demands depth / scale");
  ok(/open[- ]air|under the sky|under-the-sky|open sky/i.test(fn), "B: locationDesc guidance favours open-under-the-sky rendering where allowed");
  ok(/immersive|immersion/i.test(fn), "B: locationDesc guidance aims for an immersive world");
}

// ── B (live). Import season.ts and check the actual generated prompt text ──
async function liveChecks() {
  const mod = await import("../lib/season.ts");
  const { locationReviseSystemPrompt } = mod as any;
  for (const lang of ["ru", "en"]) {
    const p: string = locationReviseSystemPrompt(lang);
    ok(typeof p === "string" && p.length > 0, `B-live: locationReviseSystemPrompt("${lang}") returns text`);
    ok(/atmospher/i.test(p), `B-live: [${lang}] output contains atmospheric language`);
    ok(/horizon/i.test(p), `B-live: [${lang}] output references a horizon`);
    ok(/depth|foreground|scale/i.test(p), `B-live: [${lang}] output contains depth/scale language`);
    ok(/open[- ]air|under the sky|open sky/i.test(p), `B-live: [${lang}] output favours open-under-the-sky rendering`);
    // structural rule still present in the live output
    ok(/\[SHOT TYPE\]\/\[VISUAL STYLE\]/.test(p), `B-live: [${lang}] output keeps the 9-line videoPrompt structure`);
  }
}

liveChecks().then(() => {
  console.log(`\nAll ${pass} Stage 94 checks passed.`);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
