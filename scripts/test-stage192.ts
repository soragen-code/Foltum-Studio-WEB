/**
 * Stage 192 — P9: the REAL video provider call (lib/workers/video-job.ts) is verified by SOURCE
 * INSPECTION only — NO paid generation is triggered. It confirms the provider input params are the lean,
 * per-shot ones (assembled from the shot's own blocks), that audio is baked in, and that the technical
 * generation language is pinned to English (separate from the spoken dialogue language).
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage192.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}

const REPO_ROOT = join(__dirname, "..");
function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

const src = readSource("lib/workers/video-job.ts");

/* ───────────── 1) the prompt fed to the provider is assembled from the SHOT's own blocks (lean) ───────────── */
{
  ok(/import \{ assembleShotPrompt \} from "@\/lib\/prompts\/shot"/.test(src), "video-job imports assembleShotPrompt (the per-shot lean assembler)");
  ok(/const built = assembleShotPrompt\(\{/.test(src), "video-job builds the provider prompt via assembleShotPrompt({ ... })");
  ok(/const prompt = built\.prompt;/.test(src), "the provider prompt IS the assembled per-shot prompt (no bible dump appended)");
}

/* ───────────── 2) the spoken dialogue language is passed into the per-shot assembler (language separation) ───────────── */
{
  ok(/dialogueLanguage: getDialogueLanguage\(project\)/.test(src), "the per-shot prompt is built with the project's spoken dialogueLanguage");
  ok(/import \{ getDialogueLanguage \} from "@\/lib\/dialogue-language"/.test(src), "video-job imports getDialogueLanguage (spoken-language source)");
}

/* ───────────── 3) the provider input params are lean and correct (per-shot duration, vertical, audio baked in) ───────────── */
{
  ok(/duration: Math\.max\(4, Math\.round\(Number\(params\.duration \?\? shot\.duration \?\? 3\)\)\)/.test(src), "provider duration derives from the per-shot duration (min 4s, rounded)");
  ok(/resolution: SCENE_RESOLUTION/.test(src), "provider resolution uses SCENE_RESOLUTION");
  ok(/aspect_ratio: "9:16"/.test(src), "provider aspect ratio is 9:16 (vertical short-form)");
  ok(/generate_audio: true/.test(src), "provider generates audio (speech + ambience baked in)");
  ok(/watermark: false/.test(src), "provider output carries no watermark");
}

/* ───────────── 4) the TECHNICAL generation language is pinned to English, separate from spoken language ───────────── */
{
  ok(/language: "en"/.test(src), "the GenerationAttempt technical language is pinned to English");
  // the spoken language (getDialogueLanguage) drives the LINE block only; the tech language stays "en"
  ok(/style: VISUAL_STYLE_ID, language: "en"/.test(src), "tech language 'en' sits on the attempt metadata, independent of the spoken dialogueLanguage");
}

/* ───────────── 5) audio-baked-in intent is documented at the provider boundary ───────────── */
{
  ok(/generate_audio: true — speech \+ ambience baked in/.test(src), "the provider boundary documents generate_audio: true (speech + ambience baked in)");
}

console.log(`\nStage 192: PASS (${passed} checks)`);
