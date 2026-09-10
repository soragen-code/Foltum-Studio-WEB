export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { chatJSON } from "@/lib/ai";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { normalizeTestSceneResult, testSceneSystemPrompt, testSceneUserPrompt, TEST_DURATION_MAX, TEST_DURATION_MIN } from "@/lib/test-episode";
import { detectLanguage } from "@/lib/idea";

/**
 * POST /api/ai/test-scene { idea: string, durationSec?: number }
 * Stage 40: lets the LLM invent a complete self-contained test scene (9-line Seedance prompt, English lines,
 * end state, short project title) from a one-line idea. Nothing is persisted — the client fills the
 * «Тестовая серия» form with the result and the author may edit it before creating the episode.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:test-scene", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const body = (await request.json().catch(() => null)) as { idea?: unknown; durationSec?: unknown } | null;
  const idea = typeof body?.idea === "string" ? body.idea.trim() : "";
  if (idea.length < 5) return NextResponse.json({ error: "Опишите идею сцены (минимум 5 символов)" }, { status: 400 });
  if (idea.length > 2000) return NextResponse.json({ error: "Слишком длинная идея (максимум 2000 символов)" }, { status: 400 });
  const durRaw = Number(body?.durationSec);
  const durationSec = Number.isFinite(durRaw) && durRaw >= TEST_DURATION_MIN && durRaw <= TEST_DURATION_MAX ? Math.round(durRaw) : null;
  try {
    const raw = await chatJSON(testSceneSystemPrompt(), testSceneUserPrompt(idea, durationSec), { temperature: 0.8, maxTokens: 2500 });
    const result = normalizeTestSceneResult(raw);
    return NextResponse.json({ ok: true, language: detectLanguage(idea), ...result });
  } catch (err: any) {
    console.error("test-scene error:", err);
    return NextResponse.json({ error: "Не удалось придумать сцену. Попробуйте ещё раз." }, { status: 502 });
  }
}
