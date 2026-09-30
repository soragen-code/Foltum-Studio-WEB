export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { chat } from "@/lib/ai";

/**
 * POST /api/ai/translate  { text }
 *
 * Клиентский перевод произвольного текста на русский — только для ОТОБРАЖЕНИЯ (например, кнопка «РУ»
 * в просмотре промпта). На сам промпт это не влияет: в генерацию всегда уходит оригинал (англ.).
 * Ничего не пишет в БД.
 */
const schema = z.object({
  text: z.string().max(30000),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

    const text = parsed.data.text.trim();
    if (!text) return NextResponse.json({ text: "" }, { headers: { "Cache-Control": "no-store" } });

    const system =
      "You are a professional translator. Translate the user's text into natural, fluent Russian. " +
      "Preserve the original meaning, formatting, line breaks, lists, punctuation and any placeholders/variables exactly. " +
      "Output ONLY the translated text with no preamble, quotes or commentary.";

    const translated = await chat(system, text, { temperature: 0.2, maxTokens: 8000 });
    return NextResponse.json({ text: translated }, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    console.error("Translate error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
