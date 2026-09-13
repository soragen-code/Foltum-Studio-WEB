import { prisma } from "@/lib/db";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { chatJSON } from "@/lib/ai";
import { artifactImagePrompt, VISUAL_STYLE_ID } from "@/lib/visual-style";
import { detectC2paFromUrl } from "@/lib/c2pa";
import { ARTIFACT_FRAME_COUNT, REF_BATCH_CONCURRENCY, runWithConcurrency, parseImageArray } from "@/lib/reference-counts";
import { loadProjectImageProvider } from "@/lib/providers/project-provider";

// Stage 14 (E): "important objects" / artifacts of an episode. Each gets 2 photoreal
// reference frames (a clean isolated shot + one in realistic in-story context, chained on
// the first so it stays identical) with C2PA metadata, kept consistent by Seedance across shots.

const MAX_ARTIFACTS = 6;

export interface ArtifactImagesJobParams {
  jobId: string;
  projectId: string;
  episodeId: string;
}

type Extracted = { name: string; description?: string; visualPrompt: string };

function artifactExtractionSystem(language: string): string {
  return [
    "You extract the IMPORTANT STORY OBJECTS (artifacts / signature props) from a single episode script.",
    "An important object is a physical thing that MATTERS to the plot and recurs or is handled meaningfully:",
    "a weapon, device, document/letter, key, relic, tool, container, vehicle part, wearable token, etc.",
    "EXCLUDE generic set dressing (furniture, dishes, plants), people, animals, and locations.",
    "Return ONLY objects that Seedance must keep visually consistent across shots. Prefer 0–4; never invent objects not in the script.",
    `Respond as JSON: {"artifacts":[{"name": "<short name in ${language}>", "description": "<one sentence in ${language}>", "visualPrompt": "<detailed ENGLISH visual description of the object only: shape, materials, colour, size, wear, defining marks — no people, no text/logos>"}]}`,
    "If there are no important objects, return {\"artifacts\":[]}.",
  ].join(" ");
}

async function extractArtifacts(script: string, title: string, language: string): Promise<Extracted[]> {
  const raw = await chatJSON<{ artifacts?: Extracted[] }>(
    artifactExtractionSystem(language),
    `EPISODE: ${title}\n\nSCRIPT:\n${script.slice(0, 12000)}`,
    { temperature: 0.4, maxTokens: 2000 }
  );
  const list = Array.isArray(raw?.artifacts) ? raw.artifacts : [];
  return list
    .filter((a) => a && typeof a.name === "string" && a.name.trim() && typeof a.visualPrompt === "string" && a.visualPrompt.trim())
    .slice(0, MAX_ARTIFACTS)
    .map((a) => ({ name: a.name.trim().slice(0, 120), description: a.description?.trim().slice(0, 400), visualPrompt: a.visualPrompt.trim() }));
}

/**
 * Background job: ensure this episode's important objects exist and each has ARTIFACT_FRAME_COUNT
 * reference frames. Extraction runs once (LLM) if no artifacts are linked yet; frame generation is
 * concurrency-limited (≤ REF_BATCH_CONCURRENCY in flight) and idempotent. Job type "artifacts".
 */
export async function runArtifactImagesJob({ jobId, projectId, episodeId }: ArtifactImagesJobParams): Promise<void> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { language: true } });
    const language = project?.language ?? "en";
    const imageProvider = await loadProjectImageProvider(projectId); // Stage 73: transport provider only
    const episode = await prisma.episode.findFirst({
      where: { id: episodeId },
      include: { artifacts: { include: { artifact: true } } },
    });
    if (!episode) { await failJob(jobId, "Эпизод не найден"); return; }

    const canceled = () => isCancelRequested(jobId);

    // ---- Step 1: extract + link artifacts (only if none are linked yet) ----
    let linked = episode.artifacts.map((ea) => ea.artifact);
    if (linked.length === 0 && episode.script && episode.script.trim().length > 40) {
      await updateJob(jobId, { status: "processing", progress: 8, message: "Определяю важные объекты эпизода…" });
      let extracted: Extracted[] = [];
      try { extracted = await extractArtifacts(episode.script, episode.title, language); }
      catch (e: any) { console.error("[artifact-job] extraction failed:", e?.message ?? e); }

      const existing = await prisma.artifact.findMany({ where: { projectId } });
      const byName = new Map(existing.map((a) => [a.name.trim().toLowerCase(), a]));
      for (const ex of extracted) {
        if (await canceled()) { await markCanceled(jobId, "Отменено"); return; }
        let art = byName.get(ex.name.toLowerCase());
        if (!art) {
          art = await prisma.artifact.create({ data: { projectId, name: ex.name, description: ex.description ?? null, visualPrompt: ex.visualPrompt } });
          byName.set(ex.name.toLowerCase(), art);
        }
        await prisma.episodeArtifact.upsert({
          where: { episodeId_artifactId: { episodeId, artifactId: art.id } },
          create: { episodeId, artifactId: art.id },
          update: {},
        });
      }
      const relinked = await prisma.episodeArtifact.findMany({ where: { episodeId }, include: { artifact: true } });
      linked = relinked.map((ea) => ea.artifact);
    }

    if (linked.length === 0) {
      await completeJob(jobId, { artifacts: 0, frames: 0 }, "У эпизода нет важных объектов");
      return;
    }

    // ---- Step 2: generate the 2 frames per artifact (frame 0 clean, frame 1 chained on it) ----
    const total = linked.length * ARTIFACT_FRAME_COUNT;
    let done = 0;
    let failed = 0;
    let c2paMissing = 0;
    const c2paChecks: { artifactId: string; frame: number; ok: boolean; signatures: string[]; bytes: number }[] = [];
    // Local per-artifact frame state so concurrent tasks don't clobber each other.
    const state = new Map(linked.map((a) => [a.id, { primary: a.imageUrl ?? null, extra: parseImageArray(a.imageExtra) }]));
    for (const a of linked) { const s = state.get(a.id)!; if (s.primary) done += 1; done += Math.min(ARTIFACT_FRAME_COUNT - 1, s.extra.length); }

    const pct = () => 8 + Math.round((done / Math.max(total, 1)) * 90);
    const bump = async () => { await updateJob(jobId, { progress: pct(), message: `Кадры важных объектов (${done}/${total})…` }); };
    await updateJob(jobId, { status: "processing", progress: pct(), message: `Кадры важных объектов (${done}/${total})…` });

    // Pass A: frame 0 (clean isolated reference) for artifacts missing a primary frame.
    const frame0 = linked.filter((a) => !state.get(a.id)!.primary);
    await runWithConcurrency(frame0, REF_BATCH_CONCURRENCY, async (art) => {
      if (await canceled()) return;
      try {
        const remote = await generateImage(
          { prompt: artifactImagePrompt(art.visualPrompt ?? art.name, art.name, 0), aspect_ratio: "1:1" },
          { jobId, provider: imageProvider }
        );
        const url = await uploadRemoteToS3(remote, `media/public/artifacts/${projectId}/${art.id}/${VISUAL_STYLE_ID}/frame0-${Date.now()}.png`, "image/png");
        await prisma.artifact.update({ where: { id: art.id }, data: { imageUrl: url } });
        state.get(art.id)!.primary = url;
        const c2pa = await detectC2paFromUrl(url);
        c2paChecks.push({ artifactId: art.id, frame: 0, ok: c2pa.ok, signatures: c2pa.signatures, bytes: c2pa.bytes });
        if (!c2pa.ok) { c2paMissing += 1; console.warn(`[artifact-job] C2PA MISSING frame0 for ${art.name} (${url})`); }
      } catch (e: any) { failed += 1; console.error(`[artifact-job] frame0 failed for ${art.name}:`, e?.message ?? e); }
      finally { done += 1; await bump(); }
    });

    // Pass B: the remaining frames (frame 1 in-context + frame 2 close-up detail), each chained on
    // the stored frame 0 so the object stays identical. One task per artifact generates its missing
    // extras sequentially (so concurrent tasks never clobber the shared imageExtra array).
    if (!(await canceled())) {
      const needExtra = linked.filter((a) => { const s = state.get(a.id)!; return s.primary && s.extra.length < ARTIFACT_FRAME_COUNT - 1; });
      await runWithConcurrency(needExtra, REF_BATCH_CONCURRENCY, async (art) => {
        const s = state.get(art.id)!;
        if (!s.primary) { done += ARTIFACT_FRAME_COUNT - 1 - s.extra.length; await bump(); return; }
        // Frame index in the ARTIFACT_VARIANTS cycle: frame 0 is the primary; extras are frames 1..N-1.
        for (let frame = s.extra.length + 1; frame <= ARTIFACT_FRAME_COUNT - 1; frame++) {
          if (await canceled()) return;
          try {
            const remote = await generateImage(
              { prompt: artifactImagePrompt(art.visualPrompt ?? art.name, art.name, frame), aspect_ratio: "1:1", image_input: [s.primary] },
              { jobId, provider: imageProvider }
            );
            const url = await uploadRemoteToS3(remote, `media/public/artifacts/${projectId}/${art.id}/${VISUAL_STYLE_ID}/frame${frame}-${Date.now()}.png`, "image/png");
            s.extra.push(url);
            await prisma.artifact.update({ where: { id: art.id }, data: { imageExtra: JSON.stringify(s.extra) } });
            const c2pa = await detectC2paFromUrl(url);
            c2paChecks.push({ artifactId: art.id, frame, ok: c2pa.ok, signatures: c2pa.signatures, bytes: c2pa.bytes });
            if (!c2pa.ok) { c2paMissing += 1; console.warn(`[artifact-job] C2PA MISSING frame${frame} for ${art.name} (${url})`); }
          } catch (e: any) { failed += 1; console.error(`[artifact-job] frame${frame} failed for ${art.name}:`, e?.message ?? e); }
          finally { done += 1; await bump(); }
        }
      });
    }

    if (await canceled()) { await markCanceled(jobId, `Отменено — готово ${done} из ${total} кадров`); return; }

    await completeJob(
      jobId,
      { artifacts: linked.length, frames: total, failed, c2paOk: c2paMissing === 0, c2paMissing, c2paChecks },
      failed > 0 ? `Готово — не удалось ${failed} из ${total} кадров` : "Кадры важных объектов готовы"
    );
  } catch (err: any) {
    console.error("[artifact-job] failed:", err);
    await failJob(jobId, err?.message ?? "Artifact image generation failed");
  }
}
