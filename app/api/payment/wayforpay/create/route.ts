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
    const base = process.env.NEXTAUTH_URL ?? "https://foltum-studio-web.vercel.app";

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
      returnUrl: `${base}/pricing?order=${encodeURIComponent(orderReference)}`,
      merchantSignature,
    };

    return NextResponse.json({ action: WFP_PURCHASE_URL, fields });
  } catch (err: any) {
    console.error("WayForPay create error:", err);
    return NextResponse.json({ error: "Failed to create payment" }, { status: 500 });
  }
}
