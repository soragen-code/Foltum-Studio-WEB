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

// Paid-only credit model: 1 credit = 1 second of video = $1. Prices in USD.
// Subscriptions grant FEATURE ACCESS only (credits: 0) — credits are pack-only.
export const WFP_PRODUCTS: Record<string, WfpProduct> = {
  // Subscription plans (set tier + unlock features; they do NOT grant credits)
  basic: { id: "basic", name: "Foltum Studio — Basic (access plan)", amount: 29, credits: 0, kind: "subscription", tier: "basic" },
  pro: { id: "pro", name: "Foltum Studio — Pro (access plan)", amount: 99, credits: 0, kind: "subscription", tier: "pro" },
  studio: { id: "studio", name: "Foltum Studio — Studio (access plan)", amount: 299, credits: 0, kind: "subscription", tier: "studio" },
  // One-off credit packs
  mini: { id: "mini", name: "20 credits pack", amount: 20, credits: 20, kind: "credits" },
  plus: { id: "plus", name: "60 credits pack", amount: 54, credits: 60, kind: "credits" },
  max: { id: "max", name: "150 credits pack", amount: 120, credits: 150, kind: "credits" },
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
