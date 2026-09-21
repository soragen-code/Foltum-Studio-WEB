export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";

/**
 * WayForPay browser return handler.
 *
 * After a payment WayForPay returns the USER'S BROWSER to `returnUrl` — and it does so with a
 * POST request carrying the transaction result fields. A Next.js page.tsx only handles GET, so a
 * POST landing there produced the "server not found" screen. This route accepts BOTH POST and GET,
 * extracts the orderReference (from the ?order= query and/or the posted form body), and 303-redirects
 * the browser to the normal GET success page (/payment/success?order=...).
 *
 * It NEVER grants credits — crediting is done idempotently by the server-to-server webhook
 * (/api/payment/wayforpay/callback). This handler only gets the user onto a clean GET page.
 */

function baseFrom(request: Request): string {
  const fwdHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const fwdProto = request.headers.get("x-forwarded-proto") ?? "https";
  if (fwdHost) return `${fwdProto}://${fwdHost}`;
  try {
    return new URL(request.url).origin;
  } catch {
    return process.env.NEXTAUTH_URL ?? "https://www.foltum-studio.com";
  }
}

function successRedirect(request: Request, order: string | null) {
  const base = baseFrom(request);
  const target = new URL("/payment/success", base);
  if (order) target.searchParams.set("order", order);
  // 303 forces the browser to follow with GET, converting WayForPay's POST into a clean GET navigation.
  return NextResponse.redirect(target, 303);
}

export async function GET(request: Request) {
  const order = new URL(request.url).searchParams.get("order");
  return successRedirect(request, order);
}

export async function POST(request: Request) {
  // Prefer the ?order= query; fall back to an orderReference field in the posted form body.
  let order = new URL(request.url).searchParams.get("order");
  if (!order) {
    try {
      const form = await request.formData();
      const ref = form.get("orderReference");
      if (typeof ref === "string" && ref) order = ref;
    } catch {
      // Not form-encoded (or empty body) — just redirect to the generic success page.
    }
  }
  return successRedirect(request, order);
}
