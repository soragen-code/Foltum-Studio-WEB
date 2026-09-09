/**
 * Stage 12 tests. Run: npx tsx scripts/test-stage12.ts
 * Covers: story-file parsing, story-mode idea schema + prompt, and (later commits) full-story
 * field, ep1/2 voiceover prompt, out-of-order generation, trailer removal.
 */
import assert from "node:assert";
import fs from "node:fs";
import { parseStoryFile, storyKindFromName, cleanStoryText, STORY_MAX_CHARS } from "../lib/parse-story";
import { ideaSchema } from "../lib/validations";
import { ideaFromStorySystemPrompt, ideaFromStoryUserPrompt, detectLanguage } from "../lib/idea";

let pass = 0;
const ok = (cond: unknown, msg: string) => { assert(cond, msg); console.log("ok:", msg); pass++; };

// --- (A) story-file parsing --------------------------------------------------
ok(storyKindFromName("a.txt") === "txt" && storyKindFromName("a.MD") === "md" && storyKindFromName("a.docx") === "docx" && storyKindFromName("a.pdf") === "pdf", "storyKindFromName maps all 4 extensions");
ok(storyKindFromName("a.exe") === null && storyKindFromName("noext") === null, "storyKindFromName rejects unsupported types");
ok(cleanStoryText("a\r\n\r\n\r\n\r\nb").split("\n\n").length === 2, "cleanStoryText collapses blank lines to paragraph breaks");
ok(cleanStoryText("x".repeat(STORY_MAX_CHARS + 500)).length === STORY_MAX_CHARS, "cleanStoryText caps at STORY_MAX_CHARS");

(async () => {
  // txt / md parse from in-memory buffers
  const txt = await parseStoryFile("s.txt", Buffer.from("The Lighthouse of Cape Vell. A young keeper arrives at a remote northern island.", "utf8"));
  ok(txt.kind === "txt" && /Lighthouse/.test(txt.text), "parseStoryFile: .txt returns text");
  const md = await parseStoryFile("s.md", Buffer.from("# Title\n\nA detective investigates a missing violinist in a foggy coastal town.", "utf8"));
  ok(md.kind === "md" && /detective/.test(md.text), "parseStoryFile: .md returns text");
  // docx/pdf only if fixtures exist (created during dev)
  for (const [f, kind] of [["/tmp/story.docx", "docx"], ["/tmp/story.pdf", "pdf"]] as const) {
    if (fs.existsSync(f)) {
      const r = await parseStoryFile(f, fs.readFileSync(f));
      ok(r.kind === kind && r.text.length > 20, `parseStoryFile: .${kind} returns text`);
    }
  }
  await assert.rejects(() => parseStoryFile("s.rtf", Buffer.from("x")), /Неподдерживаемый формат/, "parseStoryFile rejects unsupported extension");
  await assert.rejects(() => parseStoryFile("s.txt", Buffer.from("short")), /Не удалось извлечь/, "parseStoryFile rejects near-empty content");

  // --- (A) idea schema: story mode ------------------------------------------
  const goodStory = "b".repeat(200);
  ok(ideaSchema.safeParse({ projectId: "c".repeat(25), fromStory: true, story: goodStory }).success, "ideaSchema accepts fromStory + story");
  ok(!ideaSchema.safeParse({ projectId: "c".repeat(25), fromStory: true, story: "x" }).success, "ideaSchema rejects fromStory with too-short story");
  // backward compatible: manual + auto still validate
  ok(ideaSchema.safeParse({ projectId: "c".repeat(25), idea: "A finished idea that is long enough." }).success, "ideaSchema still accepts manual idea (backward compatible)");
  ok(ideaSchema.safeParse({ projectId: "c".repeat(25), auto: true, genres: ["detective"] }).success, "ideaSchema still accepts auto+genres (backward compatible)");

  // --- (A) story-mode prompt: canon fidelity + language ---------------------
  const sp = ideaFromStorySystemPrompt("ru");
  ok(/CANON/.test(sp) && /do NOT change the story's plot/.test(sp), "ideaFromStorySystemPrompt: treats story as canon");
  ok(/Russian/.test(sp) && /8-14/.test(sp), "ideaFromStorySystemPrompt: language + 8-14 locations");
  ok(/CANON/.test(ideaFromStoryUserPrompt("some story text")) && ideaFromStoryUserPrompt("XYZ").includes("XYZ"), "ideaFromStoryUserPrompt embeds the uploaded story");
  ok(detectLanguage("Это русская история про смотрителя маяка на севере") === "ru", "detectLanguage: Russian story detected");

  console.log(`\nALL STAGE12 CHECKS PASSED (${pass})`);
})();
