/**
 * Strip sensitive fields from a User record before returning it to the client.
 * NEVER return `password` (or anything else secret) from an API route.
 */
export interface SafeUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  credits?: number;
  subscriptionTier?: string | null;
  subscriptionExpiresAt?: Date | string | null;
  createdAt?: Date | string;
}

const SENSITIVE_FIELDS = new Set(["password", "passwordHash", "resetToken", "verificationToken"]);

export function sanitizeUser<T extends Record<string, any>>(user: T): Omit<T, "password"> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(user)) {
    if (!SENSITIVE_FIELDS.has(k)) out[k] = v;
  }
  return out as Omit<T, "password">;
}

/** Minimal identity payload for auth endpoints (signup / login). */
export function publicIdentity(user: { id: string; email: string }): { id: string; email: string } {
  return { id: user.id, email: user.email };
}
