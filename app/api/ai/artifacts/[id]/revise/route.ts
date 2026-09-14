export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground } from "@/lib/jobs";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { artifactImagePrompt, VISUAL_STYLE_ID } from "@/lib/visual-style";
import { detectC2paFromUrl } from "@/lib/c2pa";
import { loadProjectImageProvider } from "@/lib/providers/project-provider";

/**
 * POST /api/ai/artifacts/[id]/revise  { instruction }
 * Prompt-edit an important object: the instruction is folded into its visual prompt and BOTH
 * reference frames are regenerated (frame 1 chained on the new frame 0 so it stays identical).
 * C2PA is preserved on the regenerated frames. Returns the updated artifact immediately; the
 * new frames land shortly after (the client polls).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:artifact-revise", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
    if (!instruction) return NextResponse.json({ error: "Describe what to change" }, { status: 400 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const artifact = await prisma.artifact.findFirst({ where: { id, project: { userId: user.id } } });
    if (!artifact) return NextResponse.json({ error: "Object not found" }, { status: 404 });

    const newVisual = `${artifact.visualPrompt ?? artifact.name}\nRevision: ${instruction}`.slice(0, 2000);
    const updated = await prisma.artifact.update({ where: { id }, data: { visualPrompt: newVisual, imageUrl: null, imageExtra: null } });

    runInBackground(async () => {
      try {
        const imageProvider = await loadProjectImageProvider(artifact.projectId); // Stage 73
        const remote0 = await generateImage({ prompt: artifactImagePrompt(newVisual, artifact.name, 0), aspect_ratio: "1:1" }, { provider: imageProvider });
        const url0 = await uploadRemoteToS3(remote0, `media/public/artifacts/${artifact.projectId}/${id}/${VISUAL_STYLE_ID}/frame0-${Date.now()}.png`, "image/png");
        await prisma.artifact.update({ where: { id }, data: { imageUrl: url0 } });
        await detectC2paFromUrl(url0).catch(() => {});
        const remote1 = await generateImage({ prompt: artifactImagePrompt(newVisual, artifact.name, 1), aspect_ratio: "1:1", image_input: [url0] }, { provider: imageProvider });
        const url1 = await uploadRemoteToS3(remote1, `media/public/artifacts/${artifact.projectId}/${id}/${VISUAL_STYLE_ID}/frame1-${Date.now()}.png`, "image/png");
        await prisma.artifact.update({ where: { id }, data: { imageExtra: JSON.stringify([url1]) } });
        await detectC2paFromUrl(url1).catch(() => {});
      } catch (e: any) { console.error("[artifact-revise] regeneration failed:", e?.message ?? e); }
    });

    return NextResponse.json({ artifact: { ...updated, imageUrl: null, imageExtra: null } });
  } catch (err: any) {
    console.error("Artifact revise error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
