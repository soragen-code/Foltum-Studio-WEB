export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseStoryFile, STORY_MAX_BYTES, storyKindFromName } from "@/lib/parse-story";
import { detectLanguage, LANGUAGE_NAMES, type IdeaLanguage } from "@/lib/idea";

/**
 * Stage 12 — POST /api/ai/idea/parse-file  (multipart/form-data, field "file")
 * Parses an uploaded story file (.txt/.md/.docx/.pdf) into plain text on the server and
 * returns { text, kind, language, chars }. No LLM call here — the extracted text is then
 * sent to POST /api/ai/idea with { fromStory: true, story } to structure it into a season.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:idea:parse-file", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") return NextResponse.json({ error: "Файл не передан" }, { status: 400 });

    const name = (file as File).name ?? "story";
    if (!storyKindFromName(name)) return NextResponse.json({ error: "Неподдерживаемый формат. Загрузите .txt, .md, .docx или .pdf" }, { status: 400 });
    const size = (file as File).size ?? 0;
    if (size > STORY_MAX_BYTES) return NextResponse.json({ error: "Файл слишком большой (макс. 8 МБ)" }, { status: 400 });

    const buf = Buffer.from(await (file as File).arrayBuffer());
    const { kind, text } = await parseStoryFile(name, buf);
    const language: IdeaLanguage = detectLanguage(text);

    return NextResponse.json({ text, kind, language, languageName: LANGUAGE_NAMES[language], chars: text.length, filename: name });
  } catch (err: any) {
    console.error("Story parse error:", err);
    return NextResponse.json({ error: err?.message ?? "Не удалось разобрать файл" }, { status: 400 });
  }
}
