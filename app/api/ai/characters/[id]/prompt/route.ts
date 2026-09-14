export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, characterPromptSchema } from "@/lib/validations";
import { normalizePromptOverride } from "@/lib/prompt-override";
import { characterBasePrompt } from "@/lib/full-body-prompt";

/**
 * Stage 46E — view / copy / edit the character reference prompt. No credits are charged here.
 *
 * GET  → { prompt, hasOverride }  prompt = the manual override, or the AUTO full-body base prompt
 *        (exactly what the first, identity-anchor shot is generated from).
 * PUT  { prompt } → save a manual override (normalized: fences / preamble stripped); { prompt: "" } → back to auto.
 *        The override replaces the appearance description for ALL shots on the next (re)generation.
 * Ownership: character → project → userId.
 */
async function loadOwned(id: string, userId: string) {
  return prisma.character.findFirst({
    where: { id, project: { userId } },
    select: { id: true, name: true, tier: true, groupSize: true, appearance: true, promptOverride: true },
  });
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:character-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;
  const char = await loadOwned(id, session.user.id);
  if (!char) return NextResponse.json({ error: "Character not found" }, { status: 404 });

  const hasOverride = !!(char.promptOverride && char.promptOverride.trim());
  const prompt = hasOverride ? (char.promptOverride as string) : characterBasePrompt(char.appearance ?? "", char.name, char.tier, char.groupSize);
  return NextResponse.json({ ok: true, prompt, hasOverride });
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:character-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;
  const parsed = await parseBody(request, characterPromptSchema);
  if (!parsed.ok) return parsed.response;

  const char = await loadOwned(id, session.user.id);
  if (!char) return NextResponse.json({ error: "Character not found" }, { status: 404 });

  const normalized = normalizePromptOverride(parsed.data.prompt);
  const promptOverride = normalized.trim() ? normalized : null;
  await prisma.character.update({ where: { id: char.id }, data: { promptOverride } });

  const hasOverride = promptOverride !== null;
  const prompt = hasOverride ? promptOverride : characterBasePrompt(char.appearance ?? "", char.name, char.tier, char.groupSize);
  return NextResponse.json({ ok: true, prompt, hasOverride });
}
