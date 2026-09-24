export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runInBackground } from "@/lib/jobs";
import { buildManualImageRequest, getManualImageModel, isKnownManualImageModelId, MANUAL_PHOTO_COST } from "@/lib/manual-image-models";
import { MANUAL_PHOTO_JOB_TYPE, MANUAL_PROJECT_ID, runManualJob } from "@/lib/workers/manual-job";
import { requireManualUser, chargeCredits, cleanUrls } from "@/lib/manual-credits";

/**
 * Stage 234 — POST /api/manual/photo  { prompt, model, referenceUrls?: string[] }
 * Charges MANUAL_PHOTO_COST credits, creates a ManualGeneration + GenerationJob and renders in the background.
 * Returns { jobId, generation }. The prompt is sent to the provider as-is (English expected).
 */
export async function POST(request: Request) {
  const authed = await requireManualUser(request, "manual:photo");
  if ("response" in authed) return authed.response;
  const { user } = authed;

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  if (prompt.length > 4000) return NextResponse.json({ error: "Prompt is too long (max 4000 chars)" }, { status: 400 });
  const modelId = isKnownManualImageModelId(body?.model) ? String(body.model) : getManualImageModel(undefined).id;
  const def = getManualImageModel(modelId);
  const referenceUrls = cleanUrls(body?.referenceUrls, def.maxRefs);

  const charged = await chargeCredits(user, MANUAL_PHOTO_COST, `Manual photo (${def.label})`);
  if (charged) return charged;

  const { slug, body: providerBody, mode } = buildManualImageRequest(modelId, prompt, referenceUrls);
  const gen = await prisma.manualGeneration.create({
    data: { userId: user.id, kind: "photo", model: modelId, mode, prompt, referenceUrls: referenceUrls.length ? referenceUrls : undefined, status: "pending", cost: MANUAL_PHOTO_COST },
  });
  const job = await prisma.generationJob.create({
    data: { type: MANUAL_PHOTO_JOB_TYPE, status: "pending", progress: 0, message: "Queued", projectId: MANUAL_PROJECT_ID, resultData: JSON.stringify({ genId: gen.id }) },
  });
  const linked = await prisma.manualGeneration.update({ where: { id: gen.id }, data: { jobId: job.id } });

  runInBackground(() => runManualJob(job.id, gen.id, slug, providerBody));
  return NextResponse.json({ jobId: job.id, generation: linked });
}
