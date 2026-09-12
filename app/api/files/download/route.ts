export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { findOwnedFrameByUrl } from "@/lib/reference-download";
import { attachmentDisposition, safeFileStem, extFromUrl } from "@/lib/download-name";

/**
 * Stage 46E — GET /api/files/download?url=<frame url>&name=<optional file name>
 *
 * Streams ONE reference frame as an attachment (so a tap on «Скачать» saves the file instead of opening it).
 * Not a generic proxy: the URL must be a frame stored on a Character / Location of a project the caller owns.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "files:download", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const sp = new URL(request.url).searchParams;
  const url = (sp.get("url") ?? "").trim();
  if (!/^https?:\/\//i.test(url) || url.length > 2048) return NextResponse.json({ error: "Некорректный url" }, { status: 400 });

  const frame = await findOwnedFrameByUrl(session.user.id, url);
  if (!frame) return NextResponse.json({ error: "Файл не найден" }, { status: 404 });

  const requested = (sp.get("name") ?? "").trim();
  const fileName = requested ? `${safeFileStem(requested.replace(/\.[a-z0-9]{2,5}$/i, ""))}.${extFromUrl(url)}` : frame.fileName;

  const upstream = await fetch(url, { cache: "no-store" }).catch(() => null);
  if (!upstream || !upstream.ok || !upstream.body) return NextResponse.json({ error: "Не удалось загрузить файл" }, { status: 502 });

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  headers.set("Content-Disposition", attachmentDisposition(fileName));
  headers.set("Cache-Control", "private, no-store");
  return new Response(upstream.body, { status: 200, headers });
}
