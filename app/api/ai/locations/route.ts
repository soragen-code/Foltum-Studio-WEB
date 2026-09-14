export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, locationCreateSchema } from "@/lib/validations";
import { chatJSON } from "@/lib/ai";
import { locationCardSchema, locationFromNameSystemPrompt, sanitizeLocationCard, normalizeLanguage, serializeSetInventory } from "@/lib/idea";

/** GET /api/ai/locations?projectId=… → project locations. */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  const project = await prisma.project.findFirst({ where: { id: projectId, user: { email: session.user.email } }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const locations = await prisma.location.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ locations });
}

/**
 * POST /api/ai/locations  { projectId, name, note? }
 * Manual add: the LLM writes the card (description + English visual prompt) from the name. No image yet.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:locations-add", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const parsed = await parseBody(request, locationCreateSchema);
    if (!parsed.ok) return parsed.response;
    const { projectId, name, note } = parsed.data;
    const project = await prisma.project.findFirst({ where: { id: projectId, user: { email: session.user.email } } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const language = normalizeLanguage(project.language, project.synopsis ?? name);
    let card: ReturnType<typeof locationCardSchema.parse> | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !card; attempt++) {
      try {
        const raw = await chatJSON(locationFromNameSystemPrompt(language), `SYNOPSIS:\n${project.synopsis ?? "(none)"}\n\nLOCATION NAME: ${name}${note ? `\nNOTE: ${note}` : ""}`, { temperature: 0.7, maxTokens: 2000 });
        card = sanitizeLocationCard(locationCardSchema.parse(raw));
      } catch (e: any) { lastError = e?.message ?? String(e); }
    }
    if (!card) return NextResponse.json({ error: "AI returned an invalid result: " + lastError }, { status: 502 });
    const location = await prisma.location.create({ data: { projectId, name: card.name || name, description: card.description, visualPrompt: card.visualPrompt, visualPromptAuto: card.visualPrompt, setInventory: serializeSetInventory(card.setInventory) } });
    return NextResponse.json({ location });
  } catch (err: any) {
    console.error("Location add error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
