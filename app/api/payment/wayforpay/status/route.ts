export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByIp, RATE_LIMITS } from "@/lib/rate-limit";

export async function GET(request: Request) {
  const limited = rateLimitByIp(request, "payment:status", RATE_LIMITS.payment);
  if (limited) return limited;

  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const orderReference = searchParams.get("order");
    if (!orderReference) {
      return NextResponse.json({ error: "order required" }, { status: 400 });
    }

    const payment = await prisma.payment.findUnique({ where: { orderReference } });
    if (!payment || payment.userId !== user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      orderReference: payment.orderReference,
      status: payment.status,
      processed: payment.processed,
      credits: payment.credits,
      productName: payment.productName,
      balance: user.credits,
    });
  } catch (err: any) {
    console.error("WayForPay status error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
