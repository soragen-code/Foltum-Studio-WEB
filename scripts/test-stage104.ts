/**
 * Stage 104 checks (pure, static + live imports of pure builders — no network / DB / render):
 *
 *  PART A — WaveSpeed ONLY: Replicate / ModelArk / Kling code and env names are gone from lib/, app/ and
 *  package.json; the only media env key is WAVESPEED_API_KEY; Project.imageProvider defaults to "wavespeed".
 *  PART B — KEYFRAMES: Scene.keyframe* fields + patch.sql; buildKeyframeRequest (Seedream edit body, image
 *  order, camera/world prompt lines); buildImageToVideoPrompt (no [ImageN] legend, FRAME 1 / FINAL FRAME);
 *  buildSeedanceImageToVideoBody (key whitelist, duration clamp); ACE-Step music body; moodToTags coverage.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage104.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

const root = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(root, p));

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(full, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

// ───────────────────────────── PART A — WaveSpeed only ─────────────────────────────
for (const f of [
  "lib/replicate.ts",
  "lib/modelark.ts",
  "lib/providers/project-provider.ts",
  "app/api/ai/projects/[id]/providers/route.ts",
  "app/project/[id]/_components/provider-picker.tsx",
]) ok(!exists(f), `deleted: ${f}`);

{
  const re = /replicate|modelark|kling|REPLICATE_|MODELARK_|KLING_/i;
  const files = [...walk(path.join(root, "lib"), [".ts", ".tsx"]), ...walk(path.join(root, "app"), [".ts", ".tsx"]), path.join(root, "package.json")];
  const hits: string[] = [];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    text.split("\n").forEach((line, i) => { if (re.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
  ok(hits.length === 0, `no replicate/modelark/kling references in lib/, app/, package.json${hits.length ? "\n" + hits.join("\n") : ""}`);
  const pkg = JSON.parse(read("package.json"));
  ok(!pkg.dependencies?.replicate && !pkg.devDependencies?.replicate, "package.json: the replicate package is uninstalled");
}

{
  // The only media-provider env var read anywhere in lib/ or app/ is WAVESPEED_API_KEY.
  const files = [...walk(path.join(root, "lib"), [".ts", ".tsx"]), ...walk(path.join(root, "app"), [".ts", ".tsx"])];
  const keys = new Set<string>();
  for (const f of files) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(m[1]);
  }
  const media = [...keys].filter(k => /API_KEY|API_TOKEN/.test(k) && !/^(OPENAI|ABACUS|ELEVENLABS|STRIPE|RESEND|WAYFORPAY|NEXTAUTH|AUTH|AWS|GOOGLE|ANTHROPIC|GEMINI)/.test(k));
  ok(media.every(k => k === "WAVESPEED_API_KEY"), `media env keys are WaveSpeed only (${media.join(", ")})`);
  ok(keys.has("WAVESPEED_API_KEY"), "WAVESPEED_API_KEY is read");
}

{
  const schema = read("prisma/schema.prisma");
  ok(/imageProvider\s+String\s+@default\("wavespeed"\)/.test(schema), "schema: Project.imageProvider @default(\"wavespeed\")");
  ok(/videoProvider\s+String\s+@default\("wavespeed"\)/.test(schema), "schema: Project.videoProvider @default(\"wavespeed\")");
  for (const f of ["keyframeUrl", "keyframePrompt", "keyframeStatus", "keyframeError"]) ok(new RegExp(`\\n\\s*${f}\\s+String\\?`).test(schema), `schema: Scene.${f} String?`);
  const patch = read("prisma/patch.sql");
  ok(patch.includes(`ALTER TABLE "Project" ALTER COLUMN "imageProvider" SET DEFAULT 'wavespeed';`), "patch.sql: imageProvider default");
  ok(patch.includes(`UPDATE "Project" SET "imageProvider" = 'wavespeed' WHERE "imageProvider" <> 'wavespeed';`), "patch.sql: imageProvider rows migrated");
  for (const f of ["keyframeUrl", "keyframePrompt", "keyframeStatus", "keyframeError"]) ok(patch.includes(`ALTER TABLE "Scene" ADD COLUMN IF NOT EXISTS "${f}" TEXT;`), `patch.sql: Scene.${f}`);
  ok(!/DROP\s+(COLUMN|TABLE)/i.test(patch.split("Stage 104").pop() ?? ""), "patch.sql: Stage 104 adds no DROP statements");
}

{
  const validations = read("lib/validations.ts");
  ok(/GENERATION_PROVIDERS\s*=\s*\[\s*"wavespeed"\s*\]/.test(validations), "validations: GENERATION_PROVIDERS = [\"wavespeed\"]");
  const videoJob = read("lib/workers/video-job.ts");
  // Stage 111: back to text-to-video with references — the keyframe is the FIRST reference image, not an i2v start frame.
  ok(!videoJob.includes("startImageToVideoGeneration("), "video-job: no longer submits Seedance image-to-video (Stage 111)");
  ok(videoJob.includes("ensureKeyframe(sceneId)") && !videoJob.includes("ensureKeyframe(nextScene.id)"), "video-job: keyframe N still rendered (retried); no next-scene keyframe (Stage 111)");
  ok(videoJob.includes("pipelineExtra.keyframeMode = false") && videoJob.includes("pipelineExtra.lastImageUrl = null"), "video-job: pipelineExtra records keyframeMode=false / lastImageUrl=null");
  ok(videoJob.includes("startVideoGeneration({ ...input,"), "video-job: text-to-video with reference_images is the only path");
  ok(exists("app/api/ai/scenes/[id]/keyframe/route.ts"), "route: POST /api/ai/scenes/[id]/keyframe");
  const route = read("app/api/ai/scenes/[id]/keyframe/route.ts");
  ok(route.includes("episode: { season: { project: { userId: session.user.id } } }") && route.includes("rateLimitByUser("), "route: ownership + rate limit");
  const jobs = read("app/api/jobs/[id]/route.ts");
  ok(jobs.includes('job.type === "scene-keyframe"'), "jobs/[id]: keyframe jobs return the scene row");
  const ui = read("app/project/[id]/episode/[episodeId]/episode-view.tsx");
  for (const t of ["scene-keyframe-thumb", "scene-keyframe-badge", "scene-keyframe-generate"]) ok(ui.includes(`data-testid="${t}"`), `UI: ${t}`);
  ok(ui.includes("/keyframe`, { method: 'POST' }"), "UI: button posts to the keyframe route");
  ok(!ui.includes("ProviderPicker"), "UI: provider picker gone");
  const script = read("lib/scene-script.ts");
  ok(script.includes("KEYFRAME PROMPT"), "scene-script: KEYFRAME PROMPT section");
  ok(read("app/api/ai/scenes/[id]/script/route.ts").includes("keyframePrompt: scene.keyframePrompt"), "script route passes keyframePrompt");
  // Reset paths clear the keyframe fields.
  for (const f of ["app/api/ai/scenes/[id]/revise/route.ts", "app/api/ai/episodes/[id]/generate-all/route.ts", "app/api/ai/assemble-episode/polish/route.ts", "lib/workers/season-script-job.ts"]) {
    ok(read(f).includes("keyframeUrl: null, keyframePrompt: null, keyframeStatus: null, keyframeError: null"), `reset clears keyframe fields: ${f}`);
  }
  ok(!read("lib/ffmpeg.ts").includes("planSeamBridge") && !read("lib/ffmpeg.ts").includes('"film"'), "ffmpeg: FILM bridge removed");
}

// ───────────────────────────── PART B — live pure builders ─────────────────────────────
async function liveChecks() {
  const kf = await import("../lib/keyframe");
  const sp = await import("../lib/scene-prompt");
  const ws = await import("../lib/wavespeed");
  const music = await import("../lib/music");

  const S3 = "https:" + "//bucket.s3.amazonaws.com/";
  const styled = (name: string) => S3 + "public/" + name + "/" + (process.env.X ?? "") + "x.png";
  // Styled asset detection is by URL shape — use the same helper the builder uses to be robust.
  const { isStyledAsset, VISUAL_STYLE_ID } = await import("../lib/visual-style");
  const styledUrl = (name: string) => S3 + "public/characters/p1/" + VISUAL_STYLE_ID + "/" + name + ".png";
  ok(isStyledAsset(styledUrl("anna-full")), "test fixture: styled asset URL is recognised");
  void styled;

  const characters = [
    { characterId: "c1", name: "Anna", tier: "MAIN", imageFull: styledUrl("anna-full"), imageFront: styledUrl("anna-front"), age: "34" },
    { characterId: "c2", name: "Mark", tier: "MAIN", imageFull: styledUrl("mark-full"), imageFront: styledUrl("mark-front"), age: "40" },
  ];
  const location = { id: "l1", name: "Harbour pier", imageUrl: styledUrl("loc-wide"), imageReverse: styledUrl("loc-reverse"), imageDetail: styledUrl("loc-detail"), imageExtra: null };
  const videoPrompt = "[SHOT TYPE]: 0-10s wide\n[VISUAL STYLE]: Photoreal live-action, cool teal palette, 35mm grain\n[LIGHTING]: overcast noon\n[BLOCKING]: Anna at the rail, Mark behind\n[GAZE]: x\n[NON-VERBAL]: x\n[ACTION]: Anna turns\n[CHARACTER]: Anna (34): red coat; Mark (40): grey suit\n[TRANSITION]: hard cut";

  // (iii) scene 1 of episode 1 — no continuity image.
  const r1 = kf.buildKeyframeRequest({
    scene: { id: "s1", number: 1, videoPrompt, startState: "WORLD: Anna grips the wet rail, Mark two steps behind her, gulls overhead.\nCAMERA: low frontal wide shot from the pier end" },
    characters, location, continuityImageUrl: null,
  });
  ok(r1.images.length === 3 + 2, `scene 1: ${r1.images.length} images = 3 location angles + 2 cast (no continuity image)`);
  ok(r1.images[0] === location.imageUrl, "scene 1: images[0] is the location wide angle (location first, then cast)");
  ok(r1.images[3] === characters[0].imageFull, "scene 1: cast full-body anchors follow the location angles");
  ok(r1.prompt.startsWith("STILL FRAME — opening frame of shot 1 of a photorealistic vertical 9:16 drama."), "scene 1: STILL FRAME header");
  ok(r1.prompt.includes("VISUAL STYLE: Photoreal live-action, cool teal palette, 35mm grain"), "scene 1: visual identity from [VISUAL STYLE]");
  ok(r1.prompt.includes("WORLD STATE: Anna grips the wet rail, Mark two steps behind her, gulls overhead."), "scene 1: WORLD STATE without the CAMERA block");
  ok(!r1.prompt.includes("CAMERA OF THIS FRAME"), "scene 1: no CAMERA OF THIS FRAME line");
  ok(!r1.prompt.includes("Image 1 is the previous frame"), "scene 1: no continuity directive");
  ok(r1.prompt.includes("CAMERA: low frontal wide shot from the pier end."), "scene 1: scripted camera is named");
  ok(r1.prompt.includes("Image 4 = Anna (34)") && r1.prompt.includes("Image 5 = Mark (40)"), "scene 1: per-character Image k lines");
  ok(r1.prompt.includes('Image 1 = the location "Harbour pier"'), "scene 1: location Image k line");
  ok(r1.prompt.includes("No text, no captions, no watermark, no split screen, no collage. Single cinematic frame, natural motion blur allowed."), "scene 1: closing negatives line");
  ok(r1.body.aspect_ratio === "9:16" && r1.body.resolution === "1k" && r1.body.output_format === "jpeg" && r1.body.prompt_optimization_mode === "fast", "body: aspect 9:16 / 1k / jpeg / fast");
  ok(Array.isArray(r1.body.images) && (r1.body.images as string[]).length === r1.images.length && r1.body.prompt === r1.prompt, "body: images + prompt mirror the request");
  ok(kf.KEYFRAME_MODEL === "bytedance/seedream-v5.0-pro/edit", "keyframe model = Seedream v5.0 pro edit");

  // scene 2 — continuity image = scene 1 keyframe.
  const kf1 = S3 + "public/keyframes/p1/e1/s1-j1.jpg";
  const r2 = kf.buildKeyframeRequest({
    scene: { id: "s2", number: 2, videoPrompt, startState: "WORLD: same instant, Anna turning from the rail.\nCAMERA: over Mark's shoulder, medium shot, eye level" },
    characters, location, continuityImageUrl: kf1,
  });
  ok(r2.images[0] === kf1, "scene 2: images[0] is scene 1's keyframe");
  ok(r2.images.length === 6 && r2.images[1] === location.imageUrl, "scene 2: continuity → location → cast");
  ok(r2.prompt.includes("Image 1 is the previous frame of the same continuous action"), "scene 2: continuity directive");
  ok(r2.prompt.includes("RENDER IT FROM A DIFFERENT CAMERA: over Mark's shoulder, medium shot, eye level."), "scene 2: DIFFERENT CAMERA = scripted camera");
  ok(r2.prompt.includes("FORBIDDEN: reusing Image 1's camera angle, height or scale."), "scene 2: FORBIDDEN line");
  ok(!r2.prompt.includes("CAMERA OF THIS FRAME"), "scene 2: no CAMERA OF THIS FRAME line");
  ok(r2.prompt.includes("Image 5 = Anna (34)"), "scene 2: character indices shift after the continuity image");

  // no scripted camera → deterministic opening angle; vision-state input is stripped of its camera line.
  const { openingAngleForScene } = await import("../lib/prompt-seam");
  const r3 = kf.buildKeyframeRequest({
    scene: { id: "s3", number: 3, videoPrompt, startState: "CAMERA OF THIS FRAME: eye-level frontal medium shot\n\nAnna stands at the rail." },
    characters, location, continuityImageUrl: kf1,
  });
  ok(r3.prompt.includes(`RENDER IT FROM A DIFFERENT CAMERA: ${openingAngleForScene(3)}.`), "scene 3: falls back to openingAngleForScene(3)");
  ok(r3.prompt.includes("WORLD STATE: Anna stands at the rail.") && !r3.prompt.includes("CAMERA OF THIS FRAME"), "scene 3: CAMERA OF THIS FRAME stripped from the world state");

  // ≤10 images.
  const many = Array.from({ length: 12 }, (_, i) => ({ characterId: `x${i}`, name: `Extra${i}`, tier: "MAIN", imageFull: styledUrl(`x${i}`), imageFront: null }));
  const r4 = kf.buildKeyframeRequest({ scene: { id: "s4", number: 4, videoPrompt, startState: "WORLD: crowd." }, characters: many, location, continuityImageUrl: kf1 });
  ok(r4.images.length === 10 && r4.images[0] === kf1 && r4.images[1] === location.imageUrl, "cap: at most 10 images; continuity + location kept first");
  ok(r4.prompt.split("\n").filter(l => /^Image \d+ = /.test(l)).length === 9, "cap: the prompt lists only the 9 attached non-continuity images");

  // (iv) Stage 111: the i2v prompt builder is gone; stripReferenceList stays (used by the keyframe request).
  const legend = "OPENING STATE: x\n\n[SHOT TYPE]: wide\n[Image1] defines Anna's photorealistic appearance\n[Image2] the location \"Harbour pier\" — wide angle\n" + sp.LOCATION_INSIDE_NOTE;
  const stripped = sp.stripReferenceList(legend);
  ok(!stripped.includes("[Image") && !stripped.includes(sp.LOCATION_INSIDE_NOTE) && stripped.includes("[SHOT TYPE]: wide"), "stripReferenceList: legend + LOCATION_INSIDE_NOTE removed, body kept");
  ok(!("buildImageToVideoPrompt" in kf), "keyframe.ts: buildImageToVideoPrompt removed (Stage 111)");

  // (v) Seedance i2v body.
  const U1 = "https:" + "//x/1.jpg"; const U2 = "https:" + "//x/2.jpg";
  const body = ws.buildSeedanceImageToVideoBody({ prompt: "p", image: U1, last_image: U2, resolution: "480p", duration: 99, generate_audio: true });
  ok(Object.keys(body).every(k => (ws.SEEDANCE_I2V_BODY_KEYS as readonly string[]).includes(k)), "i2v body: keys ⊆ SEEDANCE_I2V_BODY_KEYS");
  ok(body.duration === ws.SEEDANCE_I2V_MAX_DURATION, `i2v body: duration clamped to ${ws.SEEDANCE_I2V_MAX_DURATION}`);
  ok(ws.buildSeedanceImageToVideoBody({ prompt: "p", image: U1, duration: 1 }).duration === ws.SEEDANCE_I2V_MIN_DURATION, `i2v body: duration clamped up to ${ws.SEEDANCE_I2V_MIN_DURATION}`);
  ok(!("last_image" in ws.buildSeedanceImageToVideoBody({ prompt: "p", image: U1 })), "i2v body: last_image omitted when absent");
  ok(body.image === U1 && body.last_image === U2, "i2v body: image / last_image kept");
  ok(ws.SEEDANCE_I2V_SLUG === "bytedance/seedance-2.5/image-to-video", "i2v slug");

  // ACE-Step music.
  const m = music.buildAceStepBody("tense", 9999);
  ok(m.lyrics === "[instrumental]" && typeof m.tags === "string" && m.tags.length > 0, "ace-step: tags + [instrumental] lyrics");
  ok(m.duration === music.ACE_STEP_MAX_DURATION, "ace-step: duration clamped to max");
  ok(music.buildAceStepBody("dark", 1).duration === music.ACE_STEP_MIN_DURATION, "ace-step: duration clamped to min");
  ok(music.MUSIC_MODEL.startsWith("wavespeed-ai/ace-step"), "ace-step: MUSIC_MODEL is ACE-Step on WaveSpeed");
  // (vi) every MOOD has tags.
  for (const mood of music.MOODS) ok(music.moodToTags(mood).trim().length > 0 && music.moodToTags(mood).includes("instrumental"), `moodToTags(${mood}) non-empty + instrumental`);
}

liveChecks()
  .then(() => console.log(`\nStage 104: PASS — ${pass} assertions`))
  .catch((e) => { console.error("\nStage 104: FAIL", e); process.exit(1); });
