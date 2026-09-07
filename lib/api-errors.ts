import { NextResponse } from "next/server";

/**
 * Consistent JSON error shape for all API routes:
 *   { error: string, code?: string }
 */
export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SERVER_ERROR";

export interface ApiErrorBody {
  error: string;
  code?: ApiErrorCode;
}

function errorResponse(status: number, error: string, code: ApiErrorCode, headers?: HeadersInit) {
  return NextResponse.json<ApiErrorBody>({ error, code }, { status, headers });
}

export const badRequest = (message = "Bad request") => errorResponse(400, message, "BAD_REQUEST");
export const unauthorized = (message = "Unauthorized") => errorResponse(401, message, "UNAUTHORIZED");
export const forbidden = (message = "Forbidden") => errorResponse(403, message, "FORBIDDEN");
export const notFound = (message = "Not found") => errorResponse(404, message, "NOT_FOUND");
export const conflict = (message = "Conflict") => errorResponse(409, message, "CONFLICT");

/** 429 with a Retry-After header (seconds). */
export const rateLimited = (retryAfterSec: number, message = "Too many requests. Please try again later.") =>
  errorResponse(429, message, "RATE_LIMITED", {
    "Retry-After": String(Math.max(1, Math.ceil(retryAfterSec))),
  });

/** 500 — never leaks internal error details to the client. */
export const serverError = (message = "Internal server error") => errorResponse(500, message, "SERVER_ERROR");
