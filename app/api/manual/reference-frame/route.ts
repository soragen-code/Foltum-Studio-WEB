export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { wavespeedSubmit, wavespeedWait } from "@/lib/wavespeed";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { getBucketConfig } from "@/lib/aws-config";
import { parseImageArray } from "@/lib/reference-counts";
import { buildManualImageRequest, getManualImageModel, isKnownManualImageModelId, MANUAL_PHOTO_COST } from "@/lib/manual-image-models";
import { requireManualUser, chargeCredits } from "@/lib/manual-credits";

type Kind = "character" | "location";

/** Load the reference row, verifying that it belongs to a project of the signed-in user. */
async function loadOwned(kind: Kind, id: string, userId: string) {
  if (kind === "character") {
    const c = await prisma.character.findFirst({
      where: { id, project: { userId } },
      select: { id: true, imageFull: true, imageFront: true, imageExtra: true, name: true },
    });
    if (!c) return null;
    return { id: c.id, name: c.name, base: c.imageFull || c.imageFront, imageExtra: c.imageExtra };
  }
  const l = await prisma.location.findFirst({
    where: { id, project: { userId } },
    select: { id: true, imageUrl: true, imageExtra: true, name: true },
  });
  if (!l) return null;
  return { id: l.id, name: l.name, base: l.imageUrl, imageExtra: l.imageExtra };
}

async function saveExtra(kind: Kind, id: string, arr: string[]) {
  const data = { imageExtra: JSON.stringify(arr) };
  if (kind === "character") await prisma.character.update({ where: { id }, data });
  else await prisma.location.update({ where: { id }, data });
}

/**
 * Stage 234 — POST /api/manual/reference-frame
 *   { kind: "character"|"location", id, prompt, model?, useBase?: boolean }
 * Renders ONE extra frame for the reference card (synchronous, ≤ 4 min) and appends it to imageExtra.
 * useBase (default true) feeds the card's main image as an i2i reference. Costs MANUAL_PHOTO_COST; refunded on failure.
 */
export async function POST(request: Request) {
  const authed = await requireManualUser(request, "manual:reference-frame");
  if ("response" in authed) return authed.response;
  const { user } = authed;

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const kind: Kind | null = body?.kind === "character" || body?.kind === "location" ? body.kind : null;
  const id = typeof body?.id === "string" ? body.id : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!kind || !id) return NextResponse.json({ error: "kind and id are required" }, { status: 400 });
  if (!prompt) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  if (prompt.length > 4000) return NextResponse.json({ error: "Prompt is too long (max 4000 chars)" }, { status: 400 });
  const useBase = body?.useBase !== false;
  const modelId = isKnownManualImageModelId(body?.model) ? String(body.model) : getManualImageModel(undefined).id;
  const def = getManualImageModel(modelId);

  const row = await loadOwned(kind, id, user.id);
  if (!row) return NextResponse.json({ error: "Reference not found" }, { status: 404 });
  const refs = useBase && row.base && row.base.startsWith("http") ? [row.base] : [];

  const charged = await chargeCredits(user, MANUAL_PHOTO_COST, `Reference frame: ${row.name} (${def.label})`);
  if (charged) return charged;

  try {
    const { slug, body: providerBody } = buildManualImageRequest(modelId, prompt, refs);
    const taskId = await wavespeedSubmit(slug, providerBody, "WaveSpeed image");
    const providerUrl = await wavespeedWait(taskId, { timeoutMs: 240_000, label: "WaveSpeed image" });
    let url = providerUrl;
    try {
      const { folderPrefix } = getBucketConfig();
      url = await uploadRemoteToS3(providerUrl, `${folderPrefix}public/references/${kind}/${id}/manual-${Date.now()}.png`, "image/png");
    } catch (err) {
      console.error("[reference-frame] S3 persist failed, keeping provider URL:", err);
    }
    // Re-read to avoid clobbering a concurrent append.
    const fresh = await loadOwned(kind, id, user.id);
    const arr = parseImageArray(fresh?.imageExtra);
    arr.push(url);
    await saveExtra(kind, id, arr);
    return NextResponse.json({ url, imageExtra: JSON.stringify(arr) });
  } catch (err: any) {
    await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: MANUAL_PHOTO_COST } } });
    await prisma.creditTransaction.create({ data: { userId: user.id, amount: MANUAL_PHOTO_COST, description: `Refund: reference frame (${row.name})` } });
    return NextResponse.json({ error: err?.message || "Generation failed" }, { status: 502 });
  }
}

/** DELETE /api/manual/reference-frame { kind, id, url } — remove one manually added frame from imageExtra. */
export async function DELETE(request: Request) {
  const authed = await requireManualUser(request, "manual:reference-frame-delete");
  if ("response" in authed) return authed.response;
  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const kind: Kind | null = body?.kind === "character" || body?.kind === "location" ? body.kind : null;
  const id = typeof body?.id === "string" ? body.id : "";
  const url = typeof body?.url === "string" ? body.url : "";
  if (!kind || !id || !url) return NextResponse.json({ error: "kind, id and url are required" }, { status: 400 });
  const row = await loadOwned(kind, id, authed.user.id);
  if (!row) return NextResponse.json({ error: "Reference not found" }, { status: 404 });
  const arr = parseImageArray(row.imageExtra).filter((u) => u !== url);
  await saveExtra(kind, id, arr);
  return NextResponse.json({ ok: true, imageExtra: JSON.stringify(arr) });
}
