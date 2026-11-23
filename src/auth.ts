// Single-user auth via Cloudflare Access: verify the Access JWT that the
// edge sets on every authenticated request. No app-level password.

import type { Env } from "./types";

const HEADER = "Cf-Access-Jwt-Assertion";
const COOKIE = "CF_Authorization";

let jwksCache: { keys: Map<string, CryptoKey>; at: number } | null = null;

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function accessKeys(env: Env): Promise<Map<string, CryptoKey>> {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetch(`https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`access certs fetch failed: ${r.status}`);
  const { keys } = await r.json<{ keys: Record<string, unknown>[] }>();
  const map = new Map<string, CryptoKey>();
  for (const jwk of keys || []) {
    if (jwk.kty !== "RSA") continue;
    map.set(
      jwk.kid as string,
      await crypto.subtle.importKey(
        "jwk",
        jwk as JsonWebKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  jwksCache = { keys: map, at: Date.now() };
  return map;
}

function jwtFromRequest(req: Request): string | null {
  const header = req.headers.get(HEADER);
  if (header) return header;
  const cookie = req.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Verify the Cloudflare Access JWT on the request and return the
 * authenticated email, or null. When CF_ACCESS_AUD is not configured
 * (local dev), every request is treated as authenticated.
 */
export async function accessEmail(env: Env, req: Request): Promise<string | null> {
  if (!env.CF_ACCESS_AUD || !env.CF_ACCESS_TEAM_DOMAIN) return "dev@local";
  const token = jwtFromRequest(req);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    const keys = await accessKeys(env);
    const key = keys.get(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlDecode(parts[2]) as BufferSource,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.CF_ACCESS_AUD)) return null;
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    return claims.email || null;
  } catch {
    return null;
  }
}

/** Clear the Access cookie on logout. */
export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
