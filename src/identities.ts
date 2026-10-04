// Identity registry: which addresses this mailbox sends and receives as.
// Identity #1 is PRIMARY_ADDRESS/DISPLAY_NAME; extras come from the
// EXTRA_IDENTITIES var as `addr=Name;addr2=Name2` pairs (name optional).

import type { Env } from "./types";

export interface Identity {
  address: string;
  name: string;
}

export function listIdentities(env: Env): Identity[] {
  const out: Identity[] = [
    { address: env.PRIMARY_ADDRESS.trim().toLowerCase(), name: env.DISPLAY_NAME },
  ];
  for (const part of (env.EXTRA_IDENTITIES || "").split(";")) {
    const i = part.indexOf("=");
    const address = (i === -1 ? part : part.slice(0, i)).trim().toLowerCase();
    const name = i === -1 ? "" : part.slice(i + 1).trim();
    if (address && !out.some((x) => x.address === address)) {
      out.push({ address, name: name || address });
    }
  }
  return out;
}

export function findIdentity(
  env: Env,
  address: string | undefined | null,
): Identity | null {
  if (!address) return null;
  const a = address.trim().toLowerCase();
  return listIdentities(env).find((i) => i.address === a) || null;
}

export function primaryIdentity(env: Env): Identity {
  return listIdentities(env)[0];
}

/** Which of our identities an inbound email was addressed to (to/cc). */
export function identityForEmail(
  env: Env,
  email: { to_addresses: string; cc_addresses: string },
): Identity | null {
  let rcpts: string[] = [];
  try {
    rcpts = JSON.parse(email.to_addresses || "[]");
  } catch {}
  try {
    rcpts = rcpts.concat(JSON.parse(email.cc_addresses || "[]"));
  } catch {}
  for (const r of rcpts) {
    const hit = findIdentity(env, r);
    if (hit) return hit;
  }
  return null;
}
