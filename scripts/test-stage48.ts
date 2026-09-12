/**
 * Stage 48 — pure tests for the Kling prompt fit (compression to ≤3000 chars) and the reference-set
 * invariants of buildScenePrompt that the moderation probe relied on.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage48.ts
 */
import assert from "node:assert";
import {
  fitKlingPrompt, truncateAtSentence, splitKlingReferenceBlock, klingBodyLimit, buildKlingPayload, capKlingReferences,
  KLING_PROMPT_MAX_CHARS, KLING_PROMPT_RETRY_CHARS, KLING_PROMPT_COMPRESSED_NOTE, KLING_MAX_REFERENCE_IMAGES,
} from "../lib/kling";
import { buildScenePrompt, MAX_REFERENCE_IMAGES, type ScenePromptCharacterLink } from "../lib/scene-prompt";
import { VISUAL_STYLE_ID } from "../lib/visual-style";

let n = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); n++; };

const imageMentions = (t: string) => (t.match(/\[Image ?\d+\]/g) ?? []).length;

const REF_BLOCK = [
  "[Image1] defines Claire's face and identity; use the scene's staging and camera.",
  "[Image2] defines Claire's full-body build, proportions and current clothing.",
  "[Image3] defines the location: wide establishing angle of the abandoned square.",
  "[Image8] defines the look of the group \"Scavengers\" (extras).",
  "The location images show the place itself; never show them as pictures inside the scene.",
].join("\n");

function longPrompt(chars: number, withRefs = true): string {
  const beat = "The camera pushes slowly toward Claire as she crosses the empty square, wind tugging her hair. She stops, exhales, and says: \"Nobody is coming back here.\" ";
  let out = "";
  while (out.length < chars) out += beat;
  return withRefs ? `${out.trim()}\n${REF_BLOCK}` : out;
}

async function main() {
  // --- constants -------------------------------------------------------------------------------
  ok("KLING_PROMPT_MAX_CHARS ≤ Kling hard limit 3072", KLING_PROMPT_MAX_CHARS <= 3072);
  ok("KLING_PROMPT_MAX_CHARS is 3000", KLING_PROMPT_MAX_CHARS === 3000);
  ok("body limit keeps a margin and a floor", klingBodyLimit(3000, 0) === 2700 && klingBodyLimit(3000, 2900) === 500);
  ok("retry target is stricter than the max", KLING_PROMPT_RETRY_CHARS < KLING_PROMPT_MAX_CHARS);
  ok("note is Russian and mentions 3000", KLING_PROMPT_COMPRESSED_NOTE.includes("3000") && /сжат/.test(KLING_PROMPT_COMPRESSED_NOTE));

  // --- truncateAtSentence -----------------------------------------------------------------------
  const short = "One. Two [Image1]. Three!";
  ok("truncate: short text unchanged", truncateAtSentence(short, 100) === short);
  const t1 = truncateAtSentence("Alpha beta gamma. Delta epsilon [Image2]. Zeta eta theta iota kappa.", 45);
  ok("truncate: cuts at a sentence boundary", t1 === "Alpha beta gamma. Delta epsilon [Image2].");
  ok("truncate: [Image N] preserved intact", imageMentions(t1) === 1 && !/\[Image$/.test(t1) && !/\[Ima/.test(t1.slice(-5)));
  const noDots = "word ".repeat(200).trim();
  const t2 = truncateAtSentence(noDots, 100);
  ok("truncate: falls back to word boundary", t2.length <= 100 && t2.length > 50 && !t2.endsWith(" "));
  const t3 = truncateAtSentence("x".repeat(500), 100);
  ok("truncate: raw slice when no boundaries", t3.length === 100);
  ok("truncate: never exceeds max", [t1, t2, t3].every((t) => t.length <= 100));

  // --- fitKlingPrompt -----------------------------------------------------------------------------
  let calls = 0;
  const neverLlm = async () => { calls++; return "unused"; };
  const p0 = "Short prompt [Image1] with dialogue: \"Hi.\"";
  const f0 = await fitKlingPrompt(p0, neverLlm);
  ok("fit: short prompt unchanged", f0.prompt === p0 && !f0.compressed && !f0.truncated && f0.note === undefined);
  ok("fit: short prompt does not call the LLM", calls === 0);
  ok("fit: originalChars reported", f0.originalChars === p0.length);

  const long = longPrompt(12_500);
  ok("fixture is long", long.length > 12_000);
  const split = splitKlingReferenceBlock(long);
  ok("split: reference block starts at the first [ImageN] line and runs to the end", split.refBlock === REF_BLOCK && !split.body.includes("[Image"));
  ok("split: imageCount drops notes for images Kling does not receive", !splitKlingReferenceBlock(long, 7).refBlock.includes("[Image8]") && splitKlingReferenceBlock(long, 7).refBlock.includes("[Image3]") && splitKlingReferenceBlock(long, 7).refBlock.includes("never show them as pictures"));
  ok("split: no block → whole text is body", splitKlingReferenceBlock("plain text").refBlock === "" && splitKlingReferenceBlock("plain text").body === "plain text");

  const systems: string[] = []; const users: string[] = [];
  const goodLlm = async (system: string, user: string) => { systems.push(system); users.push(user); return "  Claire crosses the square. \"Nobody is coming back here.\"  "; };
  const f1 = await fitKlingPrompt(long, goodLlm);
  ok("fit: long prompt calls the LLM once", systems.length === 1);
  ok("fit: LLM receives the body only (reference block withheld)", users[0] === split.body && !users[0].includes("[Image"));
  ok("fit: system prompt states a limit that leaves room for the block", systems[0].includes(`${klingBodyLimit(KLING_PROMPT_MAX_CHARS, REF_BLOCK.length + 1)} characters`) && klingBodyLimit(KLING_PROMPT_MAX_CHARS, REF_BLOCK.length + 1) < KLING_PROMPT_MAX_CHARS - REF_BLOCK.length);
  ok("fit: system prompt forbids censoring", /Do NOT censor/i.test(systems[0]) && /only shorten/i.test(systems[0]));
  ok("fit: system prompt demands [Image N] + dialogue verbatim", systems[0].includes("[Image N]") && /verbatim/.test(systems[0]));
  ok("fit: LLM result used (trimmed) with the block re-attached verbatim", f1.prompt === `Claire crosses the square. \"Nobody is coming back here.\"\n${REF_BLOCK}`);
  ok("fit: compressed flag + note, not truncated", f1.compressed && !f1.truncated && f1.note === KLING_PROMPT_COMPRESSED_NOTE);

  // LLM keeps overshooting → retry on its own output with the 2700 target → truncation fallback
  const limits: string[] = []; const inputs: string[] = [];
  const longLlm = async (system: string, user: string) => { limits.push(system); inputs.push(user); return longPrompt(5_000, false); };
  const f2 = await fitKlingPrompt(long, longLlm, { imageCount: 3 });
  ok("fit: retries exactly once when still too long", limits.length === 2);
  ok("fit: retry shortens the LLM's own output", inputs[1] === longPrompt(5_000, false).trim() && inputs[0] === split.body);
  ok("fit: retry asks for the stricter target", limits[1].includes(`${klingBodyLimit(KLING_PROMPT_RETRY_CHARS, splitKlingReferenceBlock(long, 3).refBlock.length + 1)} characters`) && klingBodyLimit(KLING_PROMPT_RETRY_CHARS, 0) < klingBodyLimit(KLING_PROMPT_MAX_CHARS, 0));
  ok("fit: fallback result ≤ 3000", f2.prompt.length <= KLING_PROMPT_MAX_CHARS);
  ok("fit: fallback marked truncated with note", f2.truncated && f2.compressed && f2.note === KLING_PROMPT_COMPRESSED_NOTE);
  ok("fit: fallback keeps [Image1..3] notes whole at the end", f2.prompt.endsWith(splitKlingReferenceBlock(long, 3).refBlock) && imageMentions(f2.prompt) === 3 && !f2.prompt.includes("[Image8]"));
  const f2body = f2.prompt.slice(0, f2.prompt.length - splitKlingReferenceBlock(long, 3).refBlock.length).trim();
  ok("fit: fallback body ends on a sentence boundary", /[.!?"”]$/.test(f2body));

  // LLM throws → truncation of the original body, block kept
  const f3 = await fitKlingPrompt(long, async () => { throw new Error("llm down"); });
  ok("fit: LLM failure → truncated original ≤ 3000 with block", f3.truncated && f3.prompt.length <= 3000 && long.startsWith(f3.prompt.slice(0, 40)) && f3.prompt.endsWith(REF_BLOCK));

  // Empty LLM output is ignored (treated as a failed pass)
  const f4 = await fitKlingPrompt(long, async () => "");
  ok("fit: empty LLM output falls back to truncation", f4.truncated && f4.prompt.length > 0 && f4.prompt.length <= 3000);

  // Prompt without a reference block (manual override) still fits
  const f5 = await fitKlingPrompt(longPrompt(9_000, false), async () => "short override text.");
  ok("fit: override without block → LLM text used as is", f5.prompt === "short override text." && !f5.truncated);

  // The fitted prompt goes into the Kling payload unchanged
  const payload = buildKlingPayload({ prompt: f2.prompt, referenceImages: ["https://a/1.jpg"], durationSeconds: 5 });
  ok("payload: text is the fitted prompt", payload.contents[0].type === "prompt" && payload.contents[0].text === f2.prompt);
  ok("payload: text within Kling limit", (payload.contents[0].text ?? "").length <= 3072);

  // --- buildScenePrompt reference invariants (unchanged by Stage 48 — probe showed A fails, see report) --
  const [FACE, PROFILE, FULL, EXTRA, WIDE] = ["face", "profile", "full", "extra", "wide"].map((k) => `https://cdn.example/public/references/p1/${VISUAL_STYLE_ID}/${k}.jpg`);
  const claire: ScenePromptCharacterLink = {
    characterId: "c1", name: "Claire Johnson", tier: "main", imageFront: FACE, imageProfile: PROFILE,
    imageFull: FULL, imageExtra: EXTRA, appearance: "red hair, freckles, beige blouse", age: "28",
  };
  const built = buildScenePrompt({
    scene: { id: "s1", number: 1, videoPrompt: "Claire walks through the ruined square and looks up.", sceneKind: "narration", voiceover: "The city was silent.", locationDesc: "ruined square" } as any,
    characters: [claire], location: { id: "l1", name: "Abandoned city", imageUrl: WIDE, imageReverse: null, imageDetail: null, imageExtra: null } as any,
    previous: null, provider: null, resolvedDialogueEn: "",
  });
  const kinds = built.retryRefs.map((r) => r.kind);
  // Stage 51 (46B-0 known-good): the character contributes ONLY the front portrait — the profile, the
  // full body and the extra angle are never sent to video (sending several photos trips Seedance E005).
  ok("refs: front portrait is Image1", built.referenceImages[0] === FACE);
  ok("refs: full body never sent", !built.referenceImages.includes(FULL));
  ok("refs: profile / extra never sent", !built.referenceImages.includes(PROFILE) && !built.referenceImages.includes(EXTRA));
  ok("refs: characters precede the location", kinds.indexOf("location") > kinds.lastIndexOf("character"));
  ok("refs: front portrait is included", built.referenceImages.includes(FACE));
  ok("refs: total within the cap", built.referenceImages.length <= MAX_REFERENCE_IMAGES);
  ok("refs: Kling cap keeps the same head order", capKlingReferences(built.referenceImages)[0] === built.referenceImages[0] && capKlingReferences(built.referenceImages).length <= KLING_MAX_REFERENCE_IMAGES);

  console.log(`stage48: ${n} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
