export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, locationPromptSchema } from "@/lib/validations";
import { chatJSON } from "@/lib/ai";
import { locationCardSchema, sanitizeLocationCard, locationFromNameSystemPrompt, normalizeLanguage } from "@/lib/idea";

/**
 * Stage 46E — location visual prompt: view, direct edit, «reset to auto». No credits are charged here.
 *
 * GET → { prompt, autoPrompt, hasOverride }   hasOverride = an auto snapshot exists and the live prompt differs from it.
 * PUT { prompt }      → set visualPrompt directly (manual).
 * PUT { reset: true } → visualPrompt := visualPromptAuto; for legacy rows without a snapshot the card is re-written
 *                       by the LLM (same prompt as «add location by name») and stored into BOTH columns.
 * Ownership: location → project → userId.
 */
function view(loc: { visualPrompt: string | null; visualPromptAuto: string | null }) {
  const prompt = loc.visualPrompt ?? "";
  const autoPrompt = loc.visualPromptAuto;
  const hasOverride = autoPrompt !== null && autoPrompt !== undefined && prompt.trim() !== autoPrompt.trim();
  return { ok: true, prompt, autoPrompt, hasOverride };
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:location-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;
  const loc = await prisma.location.findFirst({ where: { id, project: { userId: session.user.id } }, select: { visualPrompt: true, visualPromptAuto: true } });
  if (!loc) return NextResponse.json({ error: "Локация не найдена" }, { status: 404 });
  return NextResponse.json(view(loc));
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:location-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;
  const parsed = await parseBody(request, locationPromptSchema);
  if (!parsed.ok) return parsed.response;

  const loc = await prisma.location.findFirst({ where: { id, project: { userId: session.user.id } }, include: { project: { select: { language: true, synopsis: true } } } });
  if (!loc) return NextResponse.json({ error: "Локация не найдена" }, { status: 404 });

  if (parsed.data.reset) {
    if (loc.visualPromptAuto && loc.visualPromptAuto.trim()) {
      const updated = await prisma.location.update({ where: { id: loc.id }, data: { visualPrompt: loc.visualPromptAuto }, select: { visualPrompt: true, visualPromptAuto: true } });
      return NextResponse.json({ ...view(updated), regenerated: false });
    }
    // Legacy row (created before the snapshot existed): re-write the card with the LLM and remember it as auto.
    const language = normalizeLanguage(loc.project.language, loc.project.synopsis ?? loc.name);
    let card: ReturnType<typeof locationCardSchema.parse> | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !card; attempt++) {
      try {
        const raw = await chatJSON(
          locationFromNameSystemPrompt(language),
          `SYNOPSIS:\n${loc.project.synopsis ?? "(none)"}\n\nLOCATION NAME: ${loc.name}${loc.description ? `\nNOTE: ${loc.description}` : ""}`,
          { temperature: 0.7, maxTokens: 900 }
        );
        card = sanitizeLocationCard(locationCardSchema.parse(raw));
      } catch (e: any) { lastError = e?.message ?? String(e); }
    }
    if (!card) return NextResponse.json({ error: "Не удалось пересобрать промпт: " + lastError }, { status: 502 });
    const updated = await prisma.location.update({ where: { id: loc.id }, data: { visualPrompt: card.visualPrompt, visualPromptAuto: card.visualPrompt }, select: { visualPrompt: true, visualPromptAuto: true } });
    return NextResponse.json({ ...view(updated), regenerated: true });
  }

  const prompt = (parsed.data.prompt ?? "").replace(/\r\n?/g, "\n").trim();
  if (!prompt) return NextResponse.json({ error: "Промпт не может быть пустым — для возврата к авто используйте «Сбросить на авто»" }, { status: 400 });
  const updated = await prisma.location.update({ where: { id: loc.id }, data: { visualPrompt: prompt }, select: { visualPrompt: true, visualPromptAuto: true } });
  return NextResponse.json(view(updated));
}
