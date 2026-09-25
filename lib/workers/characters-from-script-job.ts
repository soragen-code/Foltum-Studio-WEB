import { z } from "zod";
import { prisma } from "@/lib/db";
import { streamChatJSON } from "@/lib/ai";
import { completeJob, failJob, heartbeatJob, updateJob } from "@/lib/jobs";
import { flushStreamedText, makeJobStreamWriter } from "@/lib/stream-progress";
import { characterCardSchema, characterCardToData, dedupeCast, MAX_CAST, normalizeLanguage, sanitizeCharacterCard, type CharacterCard, type IdeaLanguage } from "@/lib/idea";
import { dialogueSpeakers, matchCharacter } from "@/lib/season";
import { castPreview, sanitizeRawCast } from "@/lib/workers/season-script-job";

/**
 * References step (Step 5) — MANUAL "Create characters from script" action.
 *
 * Steps 3/4 (season structure, episode scripts) are text-only and create no Character rows. This worker reads
 * EVERY saved episode script of the project (+ the synopsis for context) and extracts the complete cast — leads,
 * supporting, episodic and crowd extras — with ONE streaming Claude Opus 5 JSON call, then persists the NEW
 * characters (case-insensitive dedupe against the existing rows → idempotent, add-only) and links the episodes /
 * scenes to the characters by name. Reference IMAGES are NOT started here — the existing buttons on the
 * References stage do that, unchanged.
 *
 * Long-call safety: the call is STREAMING (tokens → `streamedText` via castPreview so the producer watches the
 * cast appear) and runs under a 20 s heartbeat so the 3-min stale watchdog never kills the job.
 */

/** GenerationJob.type — reuses "characters" so GET /api/jobs/[id] returns the current character list while polling. */
export const CHARACTERS_FROM_SCRIPT_JOB_TYPE = "characters";

const HEARTBEAT_MS = 20_000;
/** Total budget (chars) for the script text sent to the model — keeps the prompt well inside the context window. */
const SCRIPT_CHARS_BUDGET = 220_000;

async function withHeartbeat<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => { void heartbeatJob(jobId); }, HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/** Tolerant schema: missing role/appearance/etc. get defaults (sanitizeRawCast); ≥1 named character required. */
export const scriptCastTolerantSchema = z.preprocess(
  sanitizeRawCast,
  z.object({ characters: z.array(characterCardSchema).min(1).max(MAX_CAST), locations: z.array(z.unknown()).optional().default([]) }),
);

export function charactersFromScriptSystemPrompt(language: IdeaLanguage): string {
  const lang = language === "en" ? "English" : "the story language of the script";
  return `You are a casting director and script supervisor for an original streaming series. You receive the synopsis and the FULL shooting scripts of the episodes written so far. Your job: extract EVERY character that appears in the scripts and return a complete cast list as JSON.

Rules:
- Include ABSOLUTELY EVERYONE who appears on camera or speaks: leads, family, colleagues, rivals, one-scene episodic figures (a waiter, a nurse, a taxi driver, a guard), and crowd groups (e.g. "Wedding guests", "Hospital staff"). Do not skip extras — every person the video model must render needs a card.
- "name": EXACTLY as written in the scripts (same spelling, Latin letters). Never rename, translate or transliterate; never merge two different people; never invent people who are not in the scripts. If the script uses only a function label for an extra (e.g. "NURSE"), keep that label as the name in Title Case ("Nurse").
- "tier": MAIN (carries the season), SUPPORTING (recurring), MINOR (one or two scenes), CROWD (a group; then give "groupSize" 2–500).
- "age": a concrete age or range as evidenced or implied by the scripts (e.g. "34", "late 50s", "7"). "gender": "male" or "female".
- "role": one short line — who they are in the story (in ${lang}).
- "appearance": a DETAILED English physical description usable verbatim by an image model for a neutral-background reference photo: build, height, face shape, skin, hair (colour, length, style), eyes, distinguishing marks, typical wardrobe as seen in the scripts, posture. 3–5 sentences. No real people, brands or franchises.
- "personality": 2–3 sentences (in ${lang}) — temperament, manner of speaking, what drives them, as shown by their lines and actions.
- "firstAppearance": where and how the character first appears (episode number + scene, one sentence, in ${lang}).
- Stay consistent with the scripts: a detail stated in a script (age, hair, wardrobe, limp, scar) is authoritative.

Return ONLY a JSON object: {"characters":[{"name":"...","age":"...","gender":"male|female","role":"...","appearance":"...","personality":"...","firstAppearance":"...","tier":"MAIN|SUPPORTING|MINOR|CROWD","groupSize":null}]}. No markdown, no commentary.`;
}

export function charactersFromScriptUserPrompt(
  synopsis: string,
  episodes: { number: number; title: string | null; script: string }[],
  existingNames: string[],
): string {
  // Distribute the character budget evenly across episodes so a long season still fits the prompt.
  const perEpisode = Math.max(4000, Math.floor(SCRIPT_CHARS_BUDGET / Math.max(1, episodes.length)));
  const scripts = episodes
    .map((e) => {
      const text = e.script.length > perEpisode ? `${e.script.slice(0, perEpisode)}\n[... script truncated ...]` : e.script;
      return `=== EPISODE ${e.number}${e.title ? ` «${e.title}»` : ""} — SHOOTING SCRIPT ===\n${text}`;
    })
    .join("\n\n");
  const existing = existingNames.length
    ? `\n\nCHARACTERS ALREADY IN THE PROJECT (still list them if they appear in the scripts — spell the names exactly like this): ${existingNames.join(", ")}`
    : "";
  return `SYNOPSIS (context only):\n${synopsis.slice(0, 12_000)}${existing}\n\n${scripts}\n\nExtract the COMPLETE cast of these scripts (everyone incl. extras and crowd groups) as JSON.`;
}

type SceneRow = { id: string; dialogue: string | null; dialogueEn: string | null; action: string | null; presence: string | null; entrances: string | null; videoPrompt: string | null };

/** Names of the characters present in a scene — dialogue speakers + names mentioned in the action/presence/prompt text. */
export function sceneCharacterIds(scene: SceneRow, characters: { id: string; name: string }[]): string[] {
  const ids = new Set<string>();
  for (const dlg of [scene.dialogueEn, scene.dialogue]) {
    if (!dlg) continue;
    for (const speaker of dialogueSpeakers(dlg)) {
      const hit = matchCharacter(characters, speaker);
      if (hit) ids.add(hit.id);
    }
  }
  const haystack = [scene.presence, scene.entrances, scene.action, scene.videoPrompt].filter(Boolean).join("\n").toLowerCase();
  if (haystack) {
    for (const c of characters) {
      const n = c.name.trim().toLowerCase();
      if (!n) continue;
      // Whole-word match on the full name or (for multi-word names) the first name.
      const first = n.split(/\s+/)[0];
      const re = new RegExp(`(^|[^a-z0-9])(${escapeRe(n)}${first !== n && first.length > 2 ? `|${escapeRe(first)}` : ""})([^a-z0-9]|$)`, "i");
      if (re.test(haystack)) ids.add(c.id);
    }
  }
  return [...ids];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Entry point for POST /api/ai/characters (runs in the background; the route returns the jobId immediately).
 * Never throws — every failure is written into the job (`failJob`).
 */
export async function runCharactersFromScriptJob(jobId: string, projectId: string): Promise<void> {
  try {
    await updateJob(jobId, { status: "processing", progress: 5, message: "Reading the scripts…", streamedText: null });
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        characters: { orderBy: { createdAt: "asc" } },
        seasons: {
          orderBy: { number: "asc" },
          include: {
            episodes: {
              where: { script: { not: null } },
              orderBy: { number: "asc" },
              select: { id: true, number: true, title: true, script: true, scenes: { orderBy: { number: "asc" }, select: { id: true, dialogue: true, dialogueEn: true, action: true, presence: true, entrances: true, videoPrompt: true } } },
            },
          },
        },
      },
    });
    if (!project) throw new Error("Project not found");
    const episodes = project.seasons.flatMap((s) => s.episodes).filter((e) => (e.script ?? "").trim().length > 0);
    if (!episodes.length) throw new Error("No saved episode scripts yet — write the script first (Step 4), then create the characters.");
    const language = normalizeLanguage(project.language, project.synopsis ?? "");
    const existingNames = project.characters.map((c) => c.name);

    await updateJob(jobId, { progress: 10, message: `Extracting the cast from ${episodes.length} episode script(s)…` });
    const system = charactersFromScriptSystemPrompt(language);
    const user = charactersFromScriptUserPrompt(project.synopsis ?? "", episodes.map((e) => ({ number: e.number, title: e.title, script: e.script ?? "" })), existingNames);

    let parsed: z.infer<typeof scriptCastTolerantSchema> | null = null;
    let lastError = "";
    for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
      const raw = await withHeartbeat(jobId, () =>
        streamChatJSON(system, user, { temperature: 0.4, maxTokens: 16000, onDelta: makeJobStreamWriter(jobId, { transform: castPreview }) }),
      );
      const res = scriptCastTolerantSchema.safeParse(raw);
      if (res.success) { parsed = res.data; break; }
      lastError = res.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      console.warn(`[characters-from-script] attempt ${attempt}/2 rejected: ${lastError}`);
      if (attempt < 2) await updateJob(jobId, { message: "Cast draft was incomplete — retrying…" });
    }
    if (!parsed) throw new Error(`The cast could not be extracted (invalid model output: ${lastError}). Try again.`);

    // Idempotent, add-only: keep every existing row, create only the names we do not have yet.
    const names = parsed.characters.map((c) => c.name);
    const fresh: CharacterCard[] = dedupeCast(parsed.characters, existingNames)
      .map((c) => sanitizeCharacterCard(c, names))
      .filter((c) => !matchCharacter(project.characters, c.name));
    await updateJob(jobId, { progress: 80, message: `Saving ${fresh.length} new character(s)…` });
    const created = [];
    for (const c of fresh) {
      created.push(await prisma.character.create({ data: { projectId, ...characterCardToData(c), status: "draft", imageFront: "", imageProfile: "", imageFull: "" } }));
    }
    const all = [...project.characters, ...created].map((c) => ({ id: c.id, name: c.name }));

    // Link episodes / scenes to the characters by name (skipDuplicates → safe to re-run).
    await updateJob(jobId, { progress: 90, message: "Linking characters to the scenes…" });
    let linkedScenes = 0;
    for (const ep of episodes) {
      const epIds = new Set<string>();
      for (const scene of ep.scenes) {
        const ids = sceneCharacterIds(scene, all);
        if (!ids.length) continue;
        ids.forEach((id) => epIds.add(id));
        await prisma.sceneCharacter.createMany({ data: ids.map((characterId) => ({ sceneId: scene.id, characterId })), skipDuplicates: true });
        linkedScenes++;
      }
      if (epIds.size) await prisma.episodeCharacter.createMany({ data: [...epIds].map((characterId) => ({ episodeId: ep.id, characterId })), skipDuplicates: true });
    }

    const finalPreview = parsed.characters.map((c) => `${c.name} (${c.age}) — ${c.role}\n${c.appearance} ${c.personality}`).join("\n\n");
    await flushStreamedText(jobId, finalPreview);
    await completeJob(
      jobId,
      { created: created.length, total: all.length, linkedScenes, characterIds: created.map((c) => c.id) },
      created.length ? `Characters created from the script: ${created.length} new (${all.length} total).` : `No new characters — all ${all.length} already exist.`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[characters-from-script] job ${jobId} failed:`, msg);
    await failJob(jobId, msg);
  }
}
