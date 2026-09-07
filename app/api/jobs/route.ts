export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/jobs?projectId=...&type=characters|video&active=1
 * Lists generation jobs for a project (used on mount to resume polling).
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const type = url.searchParams.get("type");
  const active = url.searchParams.get("active") === "1";
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const jobs = await prisma.generationJob.findMany({
    where: {
      projectId,
      ...(type ? { type } : {}),
      ...(active ? { status: { in: ["pending", "processing"] } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json({ jobs }, { headers: { "Cache-Control": "no-store" } });
}
