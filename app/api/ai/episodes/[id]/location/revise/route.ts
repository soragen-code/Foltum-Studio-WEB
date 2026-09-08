export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { normalizeLanguage } from "@/lib/idea";
import { locationReviseSchema, locationReviseSystemPrompt, renderScriptFromScenes } from "@/lib/season";

/**
 * POST /api/ai/episodes/[id]/location/revise { instruction }
 * LLM updates the episode's key location (name + visual description) and reflects it in every
 * scene's locationDesc / videoPrompt. Existing scene videos are kept (text only changes) — the
 * author regenerates the clips they want to update.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:location-revise", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const instruction = String(body?.instruction ?? "").trim();
  if (instruction.length < 3) return NextResponse.json({ error: "Опишите, что изменить в локации" }, { status: 400 });

  const episode = await prisma.episode.findFirst({
    where: { id, season: { project: { userId: session.user.id } } },
    include: { characters: { include: { character: true } }, scenes: { orderBy: { number: "asc" } }, season: { include: { project: true } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  const language = normalizeLanguage(episode.season.project.language, episode.season.project.synopsis ?? "");
  const user = `CURRENT LOCATION: ${episode.locationName} — ${episode.locationDesc}\nEPISODE ${episode.number} «${episode.title}»: ${episode.logline}\n\nINSTRUCTION: ${instruction}\n\nSCENES:\n${episode.scenes
    .map((s) => `#${s.number} [${s.shotType}] ${s.locationDesc}\nACTION: ${s.action}\nVIDEO PROMPT:\n${s.videoPrompt}`)
    .join("\n\n")}`;
  try {
    const raw = await chatJSON(locationReviseSystemPrompt(language), user, { temperature: 0.5, maxTokens: 14000 });
    const parsed = locationReviseSchema.parse(raw);
    const byNum = new Map(parsed.scenes.map((s) => [s.number, s]));
    await prisma.$transaction(async (tx) => {
      for (const s of episode.scenes) {
        const u = byNum.get(s.number);
        if (!u) continue;
        await tx.scene.update({ where: { id: s.id }, data: { locationDesc: u.locationDesc, videoPrompt: u.videoPrompt } });
      }
      const scenes = episode.scenes.map((s) => ({ ...s, locationDesc: byNum.get(s.number)?.locationDesc ?? s.locationDesc }));
      await tx.episode.update({
        where: { id: episode.id },
        data: {
          locationName: parsed.locationName,
          locationDesc: parsed.locationDesc,
          script: renderScriptFromScenes({ ...episode, locationName: parsed.locationName }, episode.characters.map((c) => c.character.name), scenes),
        },
      });
      // Stage 3: keep the bound project Location in sync (its reference image is regenerated from the References stage).
      if (episode.locationId) {
        await tx.location.update({ where: { id: episode.locationId }, data: { name: parsed.locationName, visualPrompt: parsed.locationDesc } });
      }
    });
    return NextResponse.json({ ok: true, locationName: parsed.locationName, locationDesc: parsed.locationDesc, updatedScenes: parsed.scenes.length });
  } catch (err) {
    console.error("[location revise]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Revision failed" }, { status: 500 });
  }
}
