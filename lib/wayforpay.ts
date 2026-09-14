import crypto from "crypto";

/**
 * WayForPay integration helpers.
 * Docs: https://wiki.wayforpay.com/view/852102
 *
 * All prices/credits are defined on the SERVER so the client cannot tamper
 * with the amount that gets charged or the credits that get granted.
 */

export const WFP_PURCHASE_URL = "https://secure.wayforpay.com/pay";
// Stage 87 — all prices are charged and displayed in US dollars.
export const WFP_CURRENCY = "USD";

export function getMerchantAccount(): string {
  const v = process.env.WAYFORPAY_MERCHANT_ACCOUNT;
  if (!v) throw new Error("WAYFORPAY_MERCHANT_ACCOUNT is not set");
  return v;
}

export function getMerchantSecret(): string {
  const v = process.env.WAYFORPAY_MERCHANT_SECRET_KEY;
  if (!v) throw new Error("WAYFORPAY_MERCHANT_SECRET_KEY is not set");
  return v;
}

export function getMerchantDomain(): string {
  // Domain must match the one registered in the WayForPay merchant cabinet.
  const explicit = process.env.WAYFORPAY_MERCHANT_DOMAIN;
  if (explicit) return explicit;
  const base = process.env.NEXTAUTH_URL ?? "https://foltum-studio-web.vercel.app";
  try {
    return new URL(base).hostname;
  } catch {
    return "foltum-studio-web.vercel.app";
  }
}

function hmacMd5(payload: string, key: string): string {
  return crypto.createHmac("md5", key).update(payload, "utf8").digest("hex");
}

/**
 * Product catalog — the single source of truth for prices & credits.
 * Prices are in USD. Adjust freely; the client only sends a productId.
 */
export type WfpProduct = {
  id: string;
  name: string;
  amount: number; // USD
  credits: number;
  kind: "subscription" | "credits";
  tier?: string;
};

// Stage 87 — prices converted from UAH to USD at ~40 ₴ = $1 and rounded to
// standard .99 price points. Credits mappings are unchanged.
export const WFP_PRODUCTS: Record<string, WfpProduct> = {
  // Subscription plans (grant monthly credits + set tier)
  basic: { id: "basic", name: "Foltum Studio — Basic (100 credits)", amount: 9.99, credits: 100, kind: "subscription", tier: "basic" },
  pro: { id: "pro", name: "Foltum Studio — Pro (400 credits)", amount: 29.99, credits: 400, kind: "subscription", tier: "pro" },
  studio: { id: "studio", name: "Foltum Studio — Studio (1500 credits)", amount: 79.99, credits: 1500, kind: "subscription", tier: "studio" },
  // One-off credit packs
  pack50: { id: "pack50", name: "50 credits pack", amount: 4.99, credits: 50, kind: "credits" },
  pack200: { id: "pack200", name: "200 credits pack", amount: 14.99, credits: 200, kind: "credits" },
  pack500: { id: "pack500", name: "500 credits pack", amount: 29.99, credits: 500, kind: "credits" },
};

export function getProduct(id: string): WfpProduct | null {
  return WFP_PRODUCTS[id] ?? null;
}

/**
 * Signature for a Purchase request.
 * Fields: merchantAccount;merchantDomainName;orderReference;orderDate;amount;currency;
 *         productName[0..n];productCount[0..n];productPrice[0..n]
 */
export function buildPurchaseSignature(params: {
  merchantAccount: string;
  merchantDomainName: string;
  orderReference: string;
  orderDate: number;
  amount: number;
  currency: string;
  productNames: string[];
  productCounts: number[];
  productPrices: number[];
}): string {
  const parts: (string | number)[] = [
    params.merchantAccount,
    params.merchantDomainName,
    params.orderReference,
    params.orderDate,
    params.amount,
    params.currency,
    ...params.productNames,
    ...params.productCounts,
    ...params.productPrices,
  ];
  return hmacMd5(parts.join(";"), getMerchantSecret());
}

/**
 * Verify signature of an incoming callback (serviceUrl webhook).
 * Fields: merchantAccount;orderReference;amount;currency;authCode;cardPan;transactionStatus;reasonCode
 */
export function verifyCallbackSignature(body: Record<string, any>): boolean {
  const parts = [
    body.merchantAccount,
    body.orderReference,
    body.amount,
    body.currency,
    body.authCode,
    body.cardPan,
    body.transactionStatus,
    body.reasonCode,
  ].join(";");
  const expected = hmacMd5(parts, getMerchantSecret());
  return expected === body.merchantSignature;
}

/**
 * Signature for the JSON response the merchant must return to WayForPay.
 * Fields: orderReference;status;time
 */
export function buildCallbackResponseSignature(orderReference: string, status: string, time: number): string {
  return hmacMd5([orderReference, status, time].join(";"), getMerchantSecret());
}

export function buildAcceptResponse(orderReference: string) {
  const time = Math.floor(Date.now() / 1000);
  return {
    orderReference,
    status: "accept",
    time,
    signature: buildCallbackResponseSignature(orderReference, "accept", time),
  };
}
