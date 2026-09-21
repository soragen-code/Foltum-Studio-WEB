export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByIp, RATE_LIMITS } from "@/lib/rate-limit";
import {
  WFP_PURCHASE_URL,
  WFP_CURRENCY,
  getMerchantAccount,
  getMerchantDomain,
  getProduct,
  buildPurchaseSignature,
} from "@/lib/wayforpay";

export async function POST(request: Request) {
  const limited = rateLimitByIp(request, "payment:create", RATE_LIMITS.payment);
  if (limited) return limited;

  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const { productId } = await request.json();
    const product = getProduct(productId);
    if (!product) {
      return NextResponse.json({ error: "Unknown product" }, { status: 400 });
    }

    const orderReference = `FS-${user.id.slice(0, 8)}-${Date.now()}`;
    const orderDate = Math.floor(Date.now() / 1000);

    await prisma.payment.create({
      data: {
        orderReference,
        userId: user.id,
        productId: product.id,
        productName: product.name,
        amount: product.amount,
        currency: WFP_CURRENCY,
        credits: product.credits,
        kind: product.kind,
        tier: product.tier ?? null,
        status: "pending",
      },
    });

    const merchantAccount = getMerchantAccount();
    const merchantDomainName = getMerchantDomain();
    // Build the base URL from the INCOMING request's origin so returnUrl/serviceUrl always point at
    // the exact domain the user is on (e.g. https://www.foltum-studio.com) — that is where the session
    // cookie lives and where WayForPay must send the browser back. This replaces the old NEXTAUTH_URL
    // default (which pointed at a stale *.vercel.app host and produced the "server not found" screen).
    // NOTE: this does NOT affect merchantSignature (returnUrl/serviceUrl are not part of the signed
    // fields) and does NOT touch WAYFORPAY_MERCHANT_DOMAIN (getMerchantDomain stays as-is).
    const fwdHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const fwdProto = request.headers.get("x-forwarded-proto") ?? "https";
    const base = fwdHost
      ? `${fwdProto}://${fwdHost}`
      : (process.env.NEXTAUTH_URL ?? "https://www.foltum-studio.com");

    const productNames = [product.name];
    const productCounts = [1];
    const productPrices = [product.amount];

    const merchantSignature = buildPurchaseSignature({
      merchantAccount,
      merchantDomainName,
      orderReference,
      orderDate,
      amount: product.amount,
      currency: WFP_CURRENCY,
      productNames,
      productCounts,
      productPrices,
    });

    // Fields to be POSTed by the client form to secure.wayforpay.com/pay
    const fields: Record<string, any> = {
      merchantAccount,
      merchantDomainName,
      merchantTransactionSecureType: "AUTO",
      orderReference,
      orderDate,
      amount: product.amount,
      currency: WFP_CURRENCY,
      "productName[]": productNames,
      "productPrice[]": productPrices,
      "productCount[]": productCounts,
      clientEmail: user.email,
      clientFirstName: user.name ?? "",
      language: "AUTO",
      serviceUrl: `${base}/api/payment/wayforpay/callback`,
      // After payment WayForPay POSTs the browser back to returnUrl. It is sent to our dedicated
      // return handler (which accepts POST+GET) instead of a page.tsx (GET-only) — that handler
      // 303-redirects the browser to the GET success page (/payment/success), which shows the
      // "Покупка успешна" screen with a "На главную" button. The order ref is carried so the success
      // page can poll payment status and confirm the credits were granted. This is the user-facing
      // browser redirect only — the server-to-server credit callback (serviceUrl above) is untouched
      // and still grants credits idempotently.
      returnUrl: `${base}/api/payment/wayforpay/return?order=${encodeURIComponent(orderReference)}`,
      merchantSignature,
    };

    return NextResponse.json({ action: WFP_PURCHASE_URL, fields });
  } catch (err: any) {
    console.error("WayForPay create error:", err);
    return NextResponse.json({ error: "Failed to create payment" }, { status: 500 });
  }
}
