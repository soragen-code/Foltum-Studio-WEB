export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import JSZip from "jszip";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { characterFrames, locationFrames, type OwnedFrame } from "@/lib/reference-download";
import { attachmentDisposition, referencesZipName } from "@/lib/download-name";

/**
 * Stage 46E — GET /api/files/download-zip?character=<id> | ?location=<id>
 * Zips every valid reference frame of ONE owned character / location as `<Name>_references.zip`.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "files:download-zip", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const sp = new URL(request.url).searchParams;
  const characterId = sp.get("character");
  const locationId = sp.get("location");
  if (!characterId && !locationId) return NextResponse.json({ error: "Укажите character или location" }, { status: 400 });

  let frames: OwnedFrame[] = [];
  let name = "";
  if (characterId) {
    const c = await prisma.character.findFirst({ where: { id: characterId, project: { userId: session.user.id } }, select: { name: true, imageFront: true, imageProfile: true, imageFull: true, imageExtra: true } });
    if (!c) return NextResponse.json({ error: "Персонаж не найден" }, { status: 404 });
    frames = characterFrames(c); name = c.name;
  } else {
    const l = await prisma.location.findFirst({ where: { id: locationId as string, project: { userId: session.user.id } }, select: { name: true, imageUrl: true, imageReverse: true, imageDetail: true, imageExtra: true } });
    if (!l) return NextResponse.json({ error: "Локация не найдена" }, { status: 404 });
    frames = locationFrames(l); name = l.name;
  }
  if (frames.length === 0) return NextResponse.json({ error: "Нет кадров для скачивания" }, { status: 404 });

  const zip = new JSZip();
  const results = await Promise.all(frames.map(async (f) => {
    const r = await fetch(f.url, { cache: "no-store" }).catch(() => null);
    if (!r || !r.ok) return null;
    return { name: f.fileName, data: Buffer.from(await r.arrayBuffer()) };
  }));
  let added = 0;
  const used = new Set<string>();
  for (const r of results) {
    if (!r) continue;
    let fn = r.name;
    for (let i = 2; used.has(fn); i++) fn = r.name.replace(/(\.[a-z0-9]+)$/i, `-${i}$1`);
    used.add(fn);
    zip.file(fn, r.data); added++;
  }
  if (added === 0) return NextResponse.json({ error: "Не удалось загрузить кадры" }, { status: 502 });

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(buf.length),
      "Content-Disposition": attachmentDisposition(referencesZipName(name)),
      "Cache-Control": "private, no-store",
    },
  });
}
