export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { isOwnedVideoUrl } from "@/lib/video-download";
import { attachmentDisposition, safeFileStem } from "@/lib/download-name";

/**
 * GET /api/files/download-video?url=<video url>&name=<optional file name>
 *
 * Streams ONE generated mp4 (assembled episode / scene / shot clip) from the caller's OWN project
 * as a same-origin attachment. Two uses:
 *   1) A plain tap on the link downloads the file instead of opening it (Content-Disposition).
 *   2) The client can fetch these bytes WITHOUT a cross-origin CORS problem and hand the resulting
 *      File to the Web Share API — on a phone that shows the native sheet with "Save Video",
 *      putting the clip straight into the media library / camera roll.
 *
 * Not a generic proxy: the URL must be the videoUrl of an Episode / Scene / Shot the caller owns.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const limited = rateLimitByUser(request, "files:download-video", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const sp = new URL(request.url).searchParams;
  const url = (sp.get("url") ?? "").trim();
  if (!/^https?:\/\//i.test(url) || url.length > 2048) return NextResponse.json({ error: "Invalid url" }, { status: 400 });

  const owned = await isOwnedVideoUrl(session.user.id, url);
  if (!owned) return NextResponse.json({ error: "File not found" }, { status: 404 });

  const requested = (sp.get("name") ?? "").trim();
  const stem = safeFileStem(requested.replace(/\.[a-z0-9]{2,5}$/i, ""), "video");
  const fileName = `${stem}.mp4`;

  const upstream = await fetch(url, { cache: "no-store" }).catch(() => null);
  if (!upstream || !upstream.ok || !upstream.body) return NextResponse.json({ error: "Failed to fetch video" }, { status: 502 });

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("content-type") || "video/mp4");
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  headers.set("Content-Disposition", attachmentDisposition(fileName));
  headers.set("Cache-Control", "private, no-store");
  return new Response(upstream.body, { status: 200, headers });
}
