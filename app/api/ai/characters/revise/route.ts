export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, characterReviseSchema } from "@/lib/validations";
import { chatJSON } from "@/lib/ai";
import {
  reviseCharacterSystemPrompt,
  reviseCharacterUserPrompt,
  characterCardSchema,
  sanitizeCharacterCard,
  toCharacterCard,
  normalizeLanguage,
} from "@/lib/idea";

/**
 * POST /api/ai/characters/revise  { characterId, instruction }
 *
 * "Pencil" edit on a character card: the LLM rewrites the whole card
 * (name, age, role, appearance, personality, firstAppearance) per instruction.
 * Text only — no images are generated here.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:character-revise", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, characterReviseSchema);
    if (!parsed.ok) return parsed.response;
    const { characterId, instruction } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const character = await prisma.character.findFirst({
      where: { id: characterId, project: { userId: user.id } },
      include: { project: { include: { characters: { select: { name: true } } } } },
    });
    if (!character) return NextResponse.json({ error: "Character not found" }, { status: 404 });
    if (character.project.charactersLocked)
      return NextResponse.json({ error: "Characters are locked" }, { status: 409 });

    const language = normalizeLanguage(character.project.language, character.project.synopsis ?? "");
    const card = toCharacterCard(character);

    let next: ReturnType<typeof characterCardSchema.parse> | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !next; attempt++) {
      try {
        const raw = await chatJSON(
          reviseCharacterSystemPrompt(language),
          reviseCharacterUserPrompt(character.project.synopsis ?? "", card, instruction),
          { temperature: 0.6, maxTokens: 1500 }
        );
        next = characterCardSchema.parse(raw);
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[characters/revise] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!next) return NextResponse.json({ error: "AI returned an invalid result: " + lastError }, { status: 502 });

    const clean = sanitizeCharacterCard(next, character.project.characters.map((c) => c.name));
    const appearanceChanged = clean.appearance.trim() !== (character.appearance ?? "").trim();

    const updated = await prisma.character.update({
      where: { id: characterId },
      data: {
        name: clean.name,
        age: clean.age,
        role: clean.role,
        appearance: clean.appearance,
        personality: clean.personality,
        firstAppearance: clean.firstAppearance,
        tier: clean.tier ?? character.tier,
        groupSize: clean.tier === "CROWD" ? clean.groupSize ?? character.groupSize ?? 12 : null,
        description: clean.firstAppearance,
      },
    });

    return NextResponse.json({ character: updated, appearanceChanged });
  } catch (err: any) {
    console.error("Character revise error:", err);
    return NextResponse.json({ error: "Revision failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
