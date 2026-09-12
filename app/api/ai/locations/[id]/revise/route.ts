export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, locationReviseBodySchema } from "@/lib/validations";
import { chatJSON } from "@/lib/ai";
import { locationCardSchema, reviseLocationSystemPrompt, reviseLocationUserPrompt, sanitizeLocationCard, normalizeLanguage } from "@/lib/idea";
import { startLocationImageJob } from "@/lib/location-refs";

/**
 * POST /api/ai/locations/[id]/revise  { instruction, regenerate? }
 * LLM rewrites the location card by the producer's prompt; when regenerate (default) and the
 * location already had an image, a new reference is generated (charged like a character reference).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:location-revise", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const { id } = await ctx.params;
    const parsed = await parseBody(request, locationReviseBodySchema);
    if (!parsed.ok) return parsed.response;
    const { instruction, regenerate } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const location = await prisma.location.findFirst({ where: { id, project: { userId: user.id } }, include: { project: true } });
    if (!location) return NextResponse.json({ error: "Location not found" }, { status: 404 });

    const language = normalizeLanguage(location.project.language, location.project.synopsis ?? "");
    const current = { name: location.name, description: location.description ?? "—", visualPrompt: location.visualPrompt ?? "—" };
    let card: ReturnType<typeof locationCardSchema.parse> | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !card; attempt++) {
      try {
        const raw = await chatJSON(reviseLocationSystemPrompt(language), reviseLocationUserPrompt(location.project.synopsis ?? "", current, instruction), { temperature: 0.6, maxTokens: 1200 });
        card = sanitizeLocationCard(locationCardSchema.parse(raw));
      } catch (e: any) { lastError = e?.message ?? String(e); }
    }
    if (!card) return NextResponse.json({ error: "AI returned an invalid result: " + lastError }, { status: 502 });

    // A prompt edit no longer auto-locks the reference: the user may revise as many times as
    // needed and the location stays editable until they explicitly press «Сохранить навсегда»
    // (POST /api/ai/locations/[id]/lock), which is the only place refLocked is set to true.
    // Stage 60: one-step undo — snapshot the fields this edit (and any following image
    // regeneration) may overwrite, so undo can restore both the text and the previous photos.
    const prevSnapshot = {
      kind: "location",
      name: location.name,
      description: location.description,
      visualPrompt: location.visualPrompt,
      imageUrl: location.imageUrl,
      imageReverse: location.imageReverse,
      imageDetail: location.imageDetail,
      imageExtra: location.imageExtra,
    };
    const updated = await prisma.location.update({ where: { id }, data: { name: card.name, description: card.description, visualPrompt: card.visualPrompt, prevSnapshot } });
    // Keep bound episodes' display fields in sync (they still carry locationName/locationDesc for legacy views).
    await prisma.episode.updateMany({ where: { locationId: id }, data: { locationName: card.name, locationDesc: card.description } });

    const visualChanged = card.visualPrompt.trim() !== (location.visualPrompt ?? "").trim();
    if (regenerate && location.imageUrl && visualChanged) {
      // Stage 22: clear the stored reference photos BEFORE regeneration so the frontend's
      // completeness check flips to false → reference polling resumes and the spinner holds
      // until the new photos land. The location worker overwrites imageUrl anyway, and the
      // refund check reads its own `before` map after this, so clearing first is safe.
      const cleared = await prisma.location.update({
        where: { id },
        data: { imageUrl: null, imageReverse: null, imageDetail: null, imageExtra: null },
      });
      const started = await startLocationImageJob({ user, projectId: location.projectId, locationIds: [id] });
      if ("error" in started) return NextResponse.json({ location: cleared, ...started }, { status: started.status });
      return NextResponse.json({ location: cleared, ...started });
    }
    return NextResponse.json({ location: updated, jobId: null });
  } catch (err: any) {
    console.error("Location revise error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
