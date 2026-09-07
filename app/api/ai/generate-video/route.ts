export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/**
 * Video generation for a scene.
 *
 * Credit deduction is real; the actual video generation currently returns a
 * placeholder. When a video-generation API key is provided (Minimax / Runway /
 * Replicate), the TODO block below should be replaced with the real call.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const { projectId, sceneId } = await request.json();

    const project = await prisma.project.findFirst({ where: { id: projectId } });
    const tierCost: Record<string, number> = { minimum: 1, medium: 3, maximum: 8 };
    const cost = tierCost[project?.tier ?? "minimum"] ?? 1;

    if ((user.credits ?? 0) < cost) {
      return NextResponse.json(
        { error: `Not enough credits. Need ${cost}, have ${user.credits ?? 0}` },
        { status: 400 }
      );
    }

    const sceneData = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!sceneData)
      return NextResponse.json({ error: "Scene not found" }, { status: 404 });

    // Deduct credits
    await prisma.user.update({
      where: { id: user.id },
      data: { credits: { decrement: cost } },
    });
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        amount: -cost,
        description: `Video generation for scene ${sceneData.number} (${project?.tier} tier)`,
      },
    });

    // TODO: Replace placeholder with real video generation API call.
    // When MINIMAX_API_KEY or REPLICATE_API_TOKEN is available:
    //   1. Send sceneData.videoPrompt to the video generation API
    //   2. Upload the result to S3
    //   3. Use the S3 URL as videoUrl
    const videoUrl = `https://placehold.co/640x360/1a1a2e/eab308?text=Scene+${sceneData.number}+Generated`;

    const scene = await prisma.scene.update({
      where: { id: sceneId },
      data: { videoUrl, status: "generated" },
    });

    return NextResponse.json({ scene, creditsRemaining: (user.credits ?? 0) - cost });
  } catch (err: any) {
    console.error("Video generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
