// Single-user session auth: HMAC-signed cookie, timing-safe password check.

import type { Env } from "./types";

const COOKIE = "devarts_session";

async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function signSession(env: Env): Promise<string> {
  const ttlMs = parseInt(env.SESSION_TTL_HOURS || "168", 10) * 3600_000;
  const payload = `u.${Date.now() + ttlMs}`;
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function verifySession(env: Env, req: Request): Promise<boolean> {
  const cookie = req.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const token = decodeURIComponent(m[1]);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "u") return false;
  const exp = parseInt(parts[1], 10);
  if (!exp || exp < Date.now()) return false;
  const key = await hmacKey(env);
  const payload = `${parts[0]}.${parts[1]}`;
  return crypto.subtle.verify(
    "HMAC", key, b64urlDecode(parts[2]) as BufferSource, new TextEncoder().encode(payload)
  );
}

export function sessionCookie(token: string): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** Constant-time-ish string compare for the UI password. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}
