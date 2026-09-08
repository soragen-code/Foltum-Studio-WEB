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
  assert.match(characterImagePrompt("Theo, navy blazer", "front", "Theo"), /human-like/);
  assert.match(characterImagePrompt("Theo, navy blazer", "front", "Theo"), /NOT any real actor/);
  assert.match(sanitizeVideoPrompt("cinematic noir chiaroscuro, next shot").prompt, /cinematic noir chiaroscuro, next shot/);
  assert.equal(sanitizeVideoPrompt("Mara waits", { keep: ["Mara"] }).prompt, "Mara waits");
  assert.ok(styledVisualPrompt("").includes("human-like"));
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
test("тон реплики: попадает в озвучку, но не в текст/субтитры", () => {
  const block =
    'THEO (low, guarded): "We should not be here."\n' +
    'MARA (a shaky whisper): "Then why did you come?"';
  const lines = parseDialogue(block);
  // Multi-line exchange preserved as separate speaker turns.
  assert.equal(lines.length, 2);
  // Tone captured from the parenthetical, without the surrounding parens.
  assert.equal(lines[0].tone, "low, guarded");
  assert.equal(lines[1].tone, "a shaky whisper");
  // Spoken text and subtitles stay clean — the tone cue is NOT part of the words.
  assert.equal(lines[0].text, "We should not be here.");
  assert.ok(!lines[0].text.includes("guarded"));
  const subtitle = lines.map((l) => l.text).join(" ");
  assert.ok(!subtitle.includes("guarded") && !subtitle.includes("whisper"));
  // The native-audio prompt DOES carry the delivery cue so Seedance performs it.
  const p = buildNativeAudioPrompt("base", block, [], languageName("en"));
  assert.match(p, /low, guarded/);
  assert.match(p, /a shaky whisper/);
  // ...but the cue is outside the quoted, spoken lines.
  assert.ok(p.includes('"We should not be here."'));
  assert.ok(p.includes('"Then why did you come?"'));
  // A line with no parenthetical simply has no tone.
  assert.equal(parseDialogue('Theo: "Plain line."')[0].tone, undefined);
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
