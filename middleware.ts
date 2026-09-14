import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge middleware:
 *  1. Redirects unauthenticated visitors away from protected app pages.
 *  2. Adds hardening security headers to every response (pages + API).
 *
 * Session detection is cookie-based only (no DB / JWT verification here) —
 * full verification still happens in server components / API routes via `auth()`.
 */

const SESSION_COOKIES = [
  // next-auth v5 (Auth.js)
  "authjs.session-token",
  "__Secure-authjs.session-token",
  // legacy next-auth v4 names (in case of an older session still present)
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

const PROTECTED_PREFIXES = ["/dashboard", "/project"];

const PUBLIC_PATHS = new Set([
  "/",
  "/login",
  "/signup",
  "/pricing",
  // Legal / informational pages required by the payment provider (WayForPay).
  // These MUST be reachable while logged out so reviewers and buyers can read them.
  "/terms",
  "/refund-policy",
  "/contacts",
]);
const PUBLIC_PREFIXES = ["/api/auth", "/api/signup", "/api/payment/wayforpay/callback"];

const CSP = [
  "default-src 'self'",
  // 'unsafe-inline'/'unsafe-eval' are required by Next.js runtime + inline scripts;
  // apps.abacus.ai hosts the appllm helper script loaded in app/layout.tsx.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://apps.abacus.ai",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.amazonaws.com https://replicate.delivery",
  "media-src 'self' blob: https://*.amazonaws.com https://replicate.delivery",
  "connect-src 'self' https://api.replicate.com https://*.amazonaws.com https://apps.abacus.ai",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-XSS-Protection": "0",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": CSP,
};

function applySecurityHeaders(res: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(key, value);
  }
  return res;
}

function hasSessionCookie(req: NextRequest): boolean {
  return SESSION_COOKIES.some((name) => Boolean(req.cookies.get(name)?.value));
}

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (!isPublicPath(pathname) && isProtectedPath(pathname) && !hasSessionCookie(req)) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("callbackUrl", pathname);
    return applySecurityHeaders(NextResponse.redirect(loginUrl));
  }

  return applySecurityHeaders(NextResponse.next());
}

export const config = {
  // Run on everything except Next static assets and common public files.
  matcher: ["/((?!_next/static|_next/image|favicon.svg|favicon.ico|og-image.png|robots.txt|sitemap.xml).*)"],
};
