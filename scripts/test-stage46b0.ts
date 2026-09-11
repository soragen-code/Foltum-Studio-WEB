/**
 * Stage 46B-0 checks — scenes always use the CURRENT saved character version: the stored
 * `[CHARACTER]:` line of Scene.videoPrompt (script-time copy) is rebuilt from the live Character rows
 * (appearance + age) every time buildScenePrompt runs, and the reference set follows the live imageFront.
 * A manual override keeps the producer's text verbatim except its own [CHARACTER] line. Pure, no I/O.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage46b0.ts
 */
import assert from "node:assert";
import { buildScenePrompt, liveCharacterLine, refreshCharacterLine } from "../lib/scene-prompt";
import { VISUAL_STYLE_ID } from "../lib/visual-style";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const styledUrl = (k: string) => `https://cdn.example.com/public/references/p1/${VISUAL_STYLE_ID}/${k}.jpg`;

const V1 = "Woman of 34, long dark brown hair in a low bun, olive skin, slim build, grey wool coat over a white blouse";
const V2 = "Woman of 34, short platinum blonde bob, pale skin, athletic build, red leather jacket over a black t-shirt";
const stored = [
  "[SHOT TYPE]: 0-3s wide establishing; 3-8s medium two-shot",
  "[VISUAL STYLE]: old style line",
  "[LIGHTING]: soft window light",
  "[BLOCKING]: Anna crosses to the window",
  "[GAZE]: Anna looks outside",
  "[NON-VERBAL]: tight jaw",
  "[ACTION]: kettle steams in the background",
  `[CHARACTER]: Anna (34): ${V1}; Mark (40): tall man, grey beard, navy suit`,
  "[TRANSITION]: hard cut",
].join("\n");
const scene = { id: "s1", number: 1, videoPrompt: stored, sceneKind: null, voiceover: null, dialogue: 'ANNA: "Now."', dialogueEn: 'ANNA: "Now."', language: "en", locationDesc: "Kitchen", continuesFrom: "new-sequence", startState: "", endState: "" };
const loc = { id: "loc", name: "Kitchen", imageUrl: styledUrl("k-wide"), imageReverse: styledUrl("k-rev"), imageDetail: styledUrl("k-det"), imageExtra: null };
const cast = (appearance: string, front: string) => [
  { characterId: "anna", name: "Anna", tier: "MAIN", imageFront: styledUrl(front), appearance, age: "34" },
  { characterId: "mark", name: "Mark", tier: "MAIN", imageFront: styledUrl("mark-v1"), appearance: "tall man, grey beard, navy suit", age: "40" },
];

// ── A. liveCharacterLine / refreshCharacterLine ──────────────────────────────────────────────────
{
  ok(liveCharacterLine([]) === null && liveCharacterLine([{ characterId: "x", name: "X", appearance: "  " }]) === null, "A: no appearance → no live line (stored line kept)");
  const line = liveCharacterLine(cast(V2, "anna-v2"))!;
  ok(line.startsWith("[CHARACTER]: Anna (34): ") && line.includes(V2) && line.includes("; Mark (40): tall man"), "A: live line = Name (age): appearance; ... from the live rows");
  ok(liveCharacterLine([{ characterId: "a", name: "Ann", appearance: "line one\n  line two" }]) === "[CHARACTER]: Ann: line one line two", "A: multi-line appearance is flattened to one line, no age → no parentheses");
  const r = refreshCharacterLine(stored, cast(V2, "anna-v2"));
  ok(r.includes(V2) && !r.includes(V1) && r.split("\n").length === stored.split("\n").length, "A: stored [CHARACTER] line is replaced in place (line count unchanged)");
  const noLine = stored.split("\n").filter((l) => !l.startsWith("[CHARACTER]")).join("\n");
  const ins = refreshCharacterLine(noLine, cast(V2, "anna-v2"));
  ok(ins.indexOf("[CHARACTER]:") > 0 && ins.indexOf("[CHARACTER]:") < ins.indexOf("[TRANSITION]"), "A: missing line is inserted before [TRANSITION] for auto prompts");
  ok(refreshCharacterLine(noLine, cast(V2, "anna-v2"), false) === noLine, "A: insertIfMissing=false leaves a prompt without the line untouched");
  ok(refreshCharacterLine("free text only", cast(V2, "anna-v2")) === `free text only\n${line}`, "A: no [TRANSITION] → line appended at the end");
  ok(refreshCharacterLine(stored, []) === stored, "A: no live appearance at all → stored prompt byte-identical");
}

// ── B. buildScenePrompt: v1 → v2 ─────────────────────────────────────────────────────────────────
{
  const b1 = buildScenePrompt({ scene, characters: cast(V1, "anna-v1"), location: loc, previous: null, provider: "seedance" });
  const b2 = buildScenePrompt({ scene, characters: cast(V2, "anna-v2"), location: loc, previous: null, provider: "seedance" });
  ok(b1.prompt.includes("long dark brown hair") && !b1.prompt.includes("platinum blonde"), "B: with v1 rows the prompt describes v1");
  ok(b2.prompt.includes("platinum blonde") && !b2.prompt.includes("long dark brown hair"), "B: SAME stored videoPrompt + v2 rows → prompt describes v2 only (stale script-time copy gone)");
  ok((b2.prompt.match(/\[CHARACTER\]:/g) ?? []).length === 1, "B: exactly one [CHARACTER] line in the submitted prompt");
  ok(b1.referenceImages[0] === styledUrl("anna-v1") && b2.referenceImages[0] === styledUrl("anna-v2"), "B: reference_images[0] follows the live imageFront (v1 → v2)");
  ok(b2.referenceImages.length === 5 && b2.retryRefs.filter((r) => r.kind === "character").length === 2, "B: 2 character portraits + 3 location angles, nothing else");
  // Rows without appearance (legacy / test episode): stored line untouched.
  const legacy = cast(V1, "anna-v1").map((c) => ({ ...c, appearance: null, age: null }));
  const b3 = buildScenePrompt({ scene, characters: legacy, location: loc, previous: null, provider: "seedance" });
  ok(b3.prompt.includes(V1), "B: rows without appearance keep the stored [CHARACTER] line");
}

// ── C. manual override ───────────────────────────────────────────────────────────────────────────
{
  const override = `My own text.\n[CHARACTER]: Anna (34): ${V1}\nEnd of my text.`;
  const b = buildScenePrompt({ scene: { ...scene, promptOverride: override }, characters: cast(V2, "anna-v2"), location: loc, previous: null, provider: "seedance" });
  ok(b.hasOverride && b.prompt.startsWith("My own text.\n") && b.prompt.endsWith("\nEnd of my text."), "C: override text kept verbatim around the line, no [ImageN] notes appended");
  ok(b.prompt.includes(V2) && !b.prompt.includes(V1), "C: the override's own [CHARACTER] line is rebuilt from the live rows");
  const plain = buildScenePrompt({ scene: { ...scene, promptOverride: "Just my prose, no tags." }, characters: cast(V2, "anna-v2"), location: loc, previous: null, provider: "seedance" });
  ok(plain.prompt === "Just my prose, no tags." && plain.referenceImages[0] === styledUrl("anna-v2"), "C: override without a [CHARACTER] line is untouched; references still live");
}

console.log(`\nStage 46B-0: ${pass} checks passed`);
