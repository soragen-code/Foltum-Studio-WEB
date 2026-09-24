export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runInBackground } from "@/lib/jobs";
import { buildVideoRequest, getVideoModel, resolveDuration } from "@/lib/video-models";
import { MANUAL_VIDEO_COST_PER_SEC } from "@/lib/manual-image-models";
import { MANUAL_VIDEO_JOB_TYPE, MANUAL_PROJECT_ID, runManualJob } from "@/lib/workers/manual-job";
import { requireManualUser, chargeCredits, cleanUrls } from "@/lib/manual-credits";

const MANUAL_VIDEO_MAX_REFS = 10;

/**
 * Stage 234 — POST /api/manual/video
 *   { prompt, videoModelId, mode: "t2v"|"i2v", sourceImageUrl?, referenceUrls?: string[], duration }
 * Cost = duration (seconds) × MANUAL_VIDEO_COST_PER_SEC credits. 9:16, model-default resolution, audio on.
 */
export async function POST(request: Request) {
  const authed = await requireManualUser(request, "manual:video");
  if ("response" in authed) return authed.response;
  const { user } = authed;

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  if (prompt.length > 4000) return NextResponse.json({ error: "Prompt is too long (max 4000 chars)" }, { status: 400 });
  const mode: "t2v" | "i2v" = body?.mode === "i2v" ? "i2v" : "t2v";
  const def = getVideoModel(body?.videoModelId);
  const sourceImageUrl = cleanUrls([body?.sourceImageUrl], 1)[0];
  // Stage 234e: optional last frame for i2v (Seedance `last_image`, MiniMax `end_image`).
  const lastImageUrl = mode === "i2v" && (def.bodyStyle === "seedance" || def.bodyStyle === "minimax") ? cleanUrls([body?.lastImageUrl], 1)[0] : undefined;
  const referenceUrls = def.refImages && mode === "t2v" ? cleanUrls(body?.referenceUrls, MANUAL_VIDEO_MAX_REFS) : [];

  if (mode === "i2v" && !sourceImageUrl) return NextResponse.json({ error: "First frame image is required for image-to-video" }, { status: 400 });
  if (mode === "i2v" && !def.slugI2V) return NextResponse.json({ error: `Model "${def.label}" does not support image-to-video` }, { status: 400 });
  if (mode === "t2v" && !def.slugT2V) return NextResponse.json({ error: `Model "${def.label}" does not support text-to-video` }, { status: 400 });

  const requested = Number(body?.duration ?? 5);
  const duration = resolveDuration(def, Math.max(4, Math.min(10, Number.isFinite(requested) ? requested : 5)));
  const cost = Math.max(1, duration * MANUAL_VIDEO_COST_PER_SEC);

  const charged = await chargeCredits(user, cost, `Manual video ${duration}s (${def.label})`);
  if (charged) return charged;

  let slug: string, providerBody: Record<string, unknown>;
  try {
    ({ slug, body: providerBody } = buildVideoRequest({
      def, mode, prompt, duration, aspectRatio: "9:16", generateAudio: true,
      image: mode === "i2v" ? sourceImageUrl : undefined,
      lastImage: lastImageUrl,
      referenceImages: referenceUrls.length ? referenceUrls : undefined,
    }));
  } catch (err: any) {
    await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: cost } } });
    await prisma.creditTransaction.create({ data: { userId: user.id, amount: cost, description: "Refund: manual video (invalid request)" } });
    return NextResponse.json({ error: err?.message || "Invalid video request" }, { status: 400 });
  }

  const gen = await prisma.manualGeneration.create({
    data: {
      userId: user.id, kind: "video", model: def.id, mode, prompt,
      referenceUrls: referenceUrls.length ? referenceUrls : lastImageUrl ? [lastImageUrl] : undefined,
      sourceImageUrl: mode === "i2v" ? sourceImageUrl : undefined,
      status: "pending", cost,
    },
  });
  const job = await prisma.generationJob.create({
    data: { type: MANUAL_VIDEO_JOB_TYPE, status: "pending", progress: 0, message: "Queued", projectId: MANUAL_PROJECT_ID, resultData: JSON.stringify({ genId: gen.id }) },
  });
  const linked = await prisma.manualGeneration.update({ where: { id: gen.id }, data: { jobId: job.id } });

  runInBackground(() => runManualJob(job.id, gen.id, slug, providerBody));
  return NextResponse.json({ jobId: job.id, generation: linked, duration, cost });
}
