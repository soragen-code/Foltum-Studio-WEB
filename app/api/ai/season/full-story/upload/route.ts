export const dynamic = "force-dynamic";
export const maxDuration = 800; // the season job runs in the background of this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runSeasonScriptJob, SEASON_JOB_TYPE } from "@/lib/workers/season-script-job";
import { SEASON_MIN_EPISODES, SEASON_MAX_EPISODES } from "@/lib/season";
import { parseStoryFile } from "@/lib/parse-story";
import { validatePlotUpload, splitPlotIntoEpisodes, PLOT_MAX_BYTES } from "@/lib/plot-import";

/**
 * Stage 155 — POST /api/ai/season/full-story/upload  (multipart/form-data: field "file", field "projectId")
 *
 * "Bring your own plot file": instead of letting the app build the season plot automatically, the author
 * uploads their OWN finished plot (.txt/.md/.docx/.pdf). The server extracts the text (lib/parse-story),
 * stores it in Season.fullStory (the same field the auto plot uses, so every downstream reader stays
 * uniform) and sets Season.userPlotUploaded = true — which makes the per-episode SCRIPT generator treat
 * this plot as the AUTHORITATIVE source (lib/workers/season-script-job + episodeScriptUserPrompt).
 *
 * The author's own episode/series division is preserved when present ("Серия N" / "Эпизод N" / "Episode N"
 * / chapter markers) by driving the season job's episode count from the detected sections; when the file has
 * no explicit division we fall back to the existing (auto) episode-structuring count. No raw binary is
 * persisted — only the extracted text. Returns { jobId, episodes, chars }.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  const limited = await rateLimitByUser(request, "ai-season-plot-upload", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Ожидается файл (multipart/form-data)." }, { status: 400 });
  const projectId = String(form.get("projectId") ?? "");
  const file = form.get("file");
  if (!projectId) return NextResponse.json({ error: "Не указан проект." }, { status: 400 });
  if (!file || typeof file === "string") return NextResponse.json({ error: "Файл не загружен." }, { status: 400 });

  const f = file as File;
  const filename = f.name ?? "plot";
  const validation = validatePlotUpload({ filename, mime: f.type, size: f.size ?? 0 });
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: session.user.id },
    select: { id: true, synopsis: true },
  });
  if (!project) return NextResponse.json({ error: "Проект не найден." }, { status: 404 });
  if (!project.synopsis) return NextResponse.json({ error: "Сначала подтвердите синопсис." }, { status: 400 });

  // Extract the plot text (never store the raw binary). parseStoryFile throws a user-facing error for an
  // empty / image-scanned / protected file — surface it as a graceful Russian message.
  let text: string;
  try {
    const buf = Buffer.from(await f.arrayBuffer());
    if (buf.byteLength > PLOT_MAX_BYTES) return NextResponse.json({ error: "Файл слишком большой." }, { status: 400 });
    const parsed = await parseStoryFile(filename, buf);
    text = parsed.text;
  } catch {
    return NextResponse.json({ error: "Не удалось извлечь текст из файла (файл пуст, отсканирован как изображение или защищён)." }, { status: 400 });
  }
  if (!text || text.trim().length < 20) {
    return NextResponse.json({ error: "В файле не найден текст сюжета." }, { status: 400 });
  }

  // Preserve the author's own episode division when the file has explicit markers; otherwise fall back to
  // the existing auto episode count (the season job's structure step decides it from the synopsis).
  const sections = splitPlotIntoEpisodes(text);
  const episodeCount = sections.length
    ? Math.min(SEASON_MAX_EPISODES, Math.max(SEASON_MIN_EPISODES, sections.length))
    : undefined;

  // Store the uploaded plot in Season.fullStory and mark it author-provided. The season job's deterministic
  // fullStory step is then skipped (planNextStep: fullStory already set), so the uploaded text is preserved
  // and the episode scripts are written from it.
  const existing = await prisma.season.findFirst({ where: { projectId, number: 1 }, select: { id: true } });
  if (existing) {
    await prisma.season.update({ where: { id: existing.id }, data: { fullStory: text, userPlotUploaded: true } });
  } else {
    await prisma.season.create({ data: { projectId, number: 1, fullStory: text, userPlotUploaded: true } });
  }

  await failStaleJobs({ projectId, type: SEASON_JOB_TYPE });
  const active = await prisma.generationJob.findFirst({ where: { projectId, type: SEASON_JOB_TYPE, status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
  if (active) return NextResponse.json({ jobId: active.id, resumed: true, episodes: episodeCount ?? null, chars: text.length });

  const job = await prisma.generationJob.create({ data: { type: SEASON_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId } });
  runInBackground(() => runSeasonScriptJob(job.id, projectId, episodeCount));
  return NextResponse.json({ jobId: job.id, resumed: false, episodes: episodeCount ?? null, chars: text.length });
}
