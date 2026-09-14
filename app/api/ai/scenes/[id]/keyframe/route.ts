import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function POST() {
  return NextResponse.json({ error: "Scene keyframes have been retired. Generate the scene video instead." }, { status: 410 });
}
