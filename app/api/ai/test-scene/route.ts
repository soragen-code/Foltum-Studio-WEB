export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { chatJSON } from "@/lib/ai";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { normalizeTestSceneResult, testSceneSystemPrompt, testSceneUserPrompt, TEST_EPISODE_DURATION_SEC } from "@/lib/test-episode";
import { detectLanguage } from "@/lib/idea";

/**
 * POST /api/ai/test-scene { idea: string, durationSec?: number }
 * Stage 40: lets the LLM invent a complete self-contained test scene (9-line Seedance prompt, English lines,
 * end state, short project title) from a one-line idea. Nothing is persisted — the client fills the
 * "Test episode" form with the result and the author may edit it before creating the episode.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:test-scene", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const body = (await request.json().catch(() => null)) as { idea?: unknown; durationSec?: unknown } | null;
  const idea = typeof body?.idea === "string" ? body.idea.trim() : "";
  if (idea.length < 5) return NextResponse.json({ error: "Describe the scene idea (at least 5 characters)" }, { status: 400 });
  if (idea.length > 2000) return NextResponse.json({ error: "Idea is too long (maximum 2000 characters)" }, { status: 400 });
  // Stage 46A — test scenes are always 30 s; the client value is ignored.
  const durationSec = TEST_EPISODE_DURATION_SEC;
  try {
    const raw = await chatJSON(testSceneSystemPrompt(), testSceneUserPrompt(idea, durationSec), { temperature: 0.8, maxTokens: 2500 });
    const result = normalizeTestSceneResult(raw);
    return NextResponse.json({ ok: true, language: detectLanguage(idea), ...result });
  } catch (err: any) {
    console.error("test-scene error:", err);
    return NextResponse.json({ error: "Failed to come up with a scene. Try again." }, { status: 502 });
  }
}
