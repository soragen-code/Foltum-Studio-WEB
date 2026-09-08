import assert from "node:assert/strict";
import { test } from "node:test";
import { canChainFrame, characterImagePrompt, isStyledAsset, styledVisualPrompt, VISUAL_STYLE_ID } from "../lib/visual-style";
import { sanitizeVideoPrompt } from "../lib/sanitize-prompt";
import { buildNativeAudioPrompt, parseDialogue, languageName } from "../lib/voiceover";
import { classifyProviderError, safeDiagnosticInput } from "../lib/generation-diagnostics";

const frame = "https:" + `//test.invalid/videos/${VISUAL_STYLE_ID}/frame.jpg`;
test("стилизация сохраняет действие и художественные термины", () => {
  const action = "[ACTION]: Theo opens the door.\n[TRANSITION]: Camera turns to Mara.";
  const result = styledVisualPrompt(`[VISUAL STYLE]: Photorealistic 35mm film\n${action}`);
  assert.ok(result.includes(action)); assert.ok(!result.includes("Photorealistic 35mm"));
  assert.match(characterImagePrompt("Theo, navy blazer", "front", "Theo"), /Photorealistic/);
  assert.match(characterImagePrompt("Theo, navy blazer", "front", "Theo"), /NOT any real actor/);
  assert.match(sanitizeVideoPrompt("cinematic noir chiaroscuro, next shot").prompt, /cinematic noir chiaroscuro, next shot/);
  assert.equal(sanitizeVideoPrompt("Mara waits", { keep: ["Mara"] }).prompt, "Mara waits");
  assert.ok(styledVisualPrompt("").includes("Photorealistic"));
});
test("continuity: только соседний совместимый кадр в том же месте", () => {
  const scene = { number: 7, locationDesc: "INT Living room" };
  const prev = { number: 6, locationDesc: " INT Living room ", lastFrameUrl: frame };
  assert.ok(canChainFrame(scene, prev));
  assert.ok(!canChainFrame(scene, { ...prev, number: 5 }));
  assert.ok(!canChainFrame(scene, { ...prev, lastFrameUrl: "https:" + "//test.invalid/legacy-frame" }));
  assert.ok(!canChainFrame(scene, { ...prev, locationDesc: "EXT Garden" }));
  assert.ok(!canChainFrame(scene, null)); assert.ok(!isStyledAsset(null));
  assert.ok(!isStyledAsset("https:" + `//test.invalid/old?style=/${VISUAL_STYLE_ID}/`));
});
test("EN/RU, обычные кавычки, неизменные реплики и отсутствие музыки", () => {
  for (const [dialogue, lang, expected] of [["Theo: \"We've met before.\"", "en", "We've met before."], ['Мара: "Мы уже встречались."', "ru", "Мы уже встречались."]]) {
    const p = buildNativeAudioPrompt("soft illustration", dialogue, [], languageName(lang));
    assert.ok(p.includes(`"${expected}"`)); assert.ok(!p.includes(`{${expected}}`));
    assert.match(p, /NO background music/); assert.ok(p.includes(languageName(lang)));
    assert.equal(parseDialogue(dialogue)[0].text, expected);
  }
  assert.deepEqual(parseDialogue(null), []);
  assert.deepEqual(parseDialogue("[NO DIALOGUE]"), []);
  assert.match(buildNativeAudioPrompt("", "[NO DIALOGUE]", []), /ambient sound/);
});
test("ошибки поставщика классифицируются без потери причины и утечек", () => {
  for (const [message, kind] of [
    ["output audio may be related to copyright restrictions", "copyright_audio"],
    ["output video may be related to copyright restrictions", "copyright_video"],
    ["copyright restrictions", "copyright"],
    ["flagged as sensitive (E005)", "moderation"],
    ["high demand (E003)", "overload"], ["Video model timed out", "timeout"],
  ]) assert.equal(classifyProviderError(new Error(message)), kind);
  const safe = JSON.stringify(safeDiagnosticInput({ prompt: "https://x.test/a?X-Amz-Signature=PRIVATE", error: "Bearer PRIVATE token=PRIVATE request cgt-123" }));
  assert.ok(!safe.includes("PRIVATE")); assert.ok(safe.includes("cgt-123"));
});

// Lifecycle recovery/regression coverage lives in test-video-recovery.ts.
