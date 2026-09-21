export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyCallbackSignature, buildAcceptResponse } from "@/lib/wayforpay";
import { rateLimitByIp, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * WayForPay serviceUrl webhook.
 * WayForPay POSTs the transaction result here. We must:
 *  1. verify the signature,
 *  2. grant credits exactly once (idempotent) when transactionStatus === "Approved",
 *  3. reply with a signed JSON { orderReference, status: "accept", time, signature }.
 */
export async function POST(request: Request) {
  const limited = rateLimitByIp(request, "payment:callback", RATE_LIMITS.payment);
  if (limited) return limited;

  try {
    // WayForPay may send JSON or form-encoded/raw JSON body.
    let body: Record<string, any> = {};
    const raw = await request.text();
    try {
      body = JSON.parse(raw);
    } catch {
      const params = new URLSearchParams(raw);
      // Some setups send a single JSON field
      const first = [...params.keys()][0];
      if (first && first.trim().startsWith("{")) {
        body = JSON.parse(first);
      } else {
        body = Object.fromEntries(params.entries());
      }
    }

    if (!body?.orderReference) {
      return NextResponse.json({ error: "Bad request" }, { status: 400 });
    }

    const valid = verifyCallbackSignature(body);
    if (!valid) {
      console.error("WayForPay callback: invalid signature", body.orderReference);
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }

    const payment = await prisma.payment.findUnique({
      where: { orderReference: body.orderReference },
    });

    // Always reply with a signed accept so WayForPay stops retrying,
    // but only mutate balances for a valid, not-yet-processed, approved order.
    const acceptResponse = buildAcceptResponse(body.orderReference);

    if (!payment) {
      console.error("WayForPay callback: unknown order", body.orderReference);
      return NextResponse.json(acceptResponse);
    }

    const txStatus = String(body.transactionStatus ?? "");

    await prisma.payment.update({
      where: { orderReference: payment.orderReference },
      data: {
        transactionStatus: txStatus,
        reasonCode: String(body.reasonCode ?? ""),
        status:
          txStatus === "Approved"
            ? "approved"
            : txStatus === "Refunded"
            ? "refunded"
            : txStatus === "Declined" || txStatus === "Expired"
            ? "declined"
            : payment.status,
      },
    });

    if (txStatus === "Approved" && !payment.processed) {
      // Subscriptions grant FEATURE ACCESS only (tier + 30-day expiry) and do NOT increment credits —
      // credits are pack-only. Credit packs increment the balance as before. `processed` keeps this idempotent.
      if (payment.kind === "subscription" && payment.tier) {
        await prisma.$transaction([
          prisma.user.update({
            where: { id: payment.userId },
            data: {
              // No credits increment for subscriptions.
              subscriptionTier: payment.tier,
              subscriptionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
          }),
          prisma.creditTransaction.create({
            data: {
              userId: payment.userId,
              amount: 0,
              description: `WayForPay subscription: ${payment.productName}`,
            },
          }),
          prisma.payment.update({
            where: { orderReference: payment.orderReference },
            data: { processed: true },
          }),
        ]);
      } else {
        await prisma.$transaction([
          prisma.user.update({
            where: { id: payment.userId },
            data: {
              credits: { increment: payment.credits },
            },
          }),
          prisma.creditTransaction.create({
            data: {
              userId: payment.userId,
              amount: payment.credits,
              description: `WayForPay: ${payment.productName} (${payment.orderReference})`,
            },
          }),
          prisma.payment.update({
            where: { orderReference: payment.orderReference },
            data: { processed: true },
          }),
        ]);
      }
    }

    return NextResponse.json(acceptResponse);
  } catch (err: any) {
    console.error("WayForPay callback error:", err);
    return NextResponse.json({ error: "Callback failed" }, { status: 500 });
  }
}
