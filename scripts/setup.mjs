#!/usr/bin/env node
/**
 * devarts-mail provisioning: one command, idempotent.
 *
 *   npm run setup
 *
 * What it does:
 *   1. Creates the D1 database (if needed) and writes the database_id
 *      back into wrangler.jsonc (the unified config).
 *   2. Applies migrations (remote).
 *   3. Pushes secrets from .dev.vars -> `wrangler secret put`.
 *   4. Deploys the Worker.
 *   5. Configures Email Routing rules: PRIMARY_ADDRESS + EXTRA_IDENTITIES
 *      -> this Worker.
 *
 * Auth (either works):
 *   - CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID env (or in .dev.vars), or
 *   - `wrangler login` OAuth session (token is reused automatically)
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerPath = resolve(root, "wrangler.jsonc");

// --- tiny .env/.dev.vars loader -------------------------------------------
function loadDotfile(name) {
  const p = resolve(root, name);
  if (!existsSync(p)) return {};
  return Object.fromEntries(
    readFileSync(p, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}
const fileEnv = { ...loadDotfile(".env"), ...loadDotfile(".dev.vars") };
const env = (k) => process.env[k] ?? fileEnv[k];

import { homedir, platform } from "node:os";

// wrangler's OAuth token — lets us skip CLOUDFLARE_API_TOKEN entirely.
function wranglerToken() {
  const p =
    platform() === "darwin"
      ? resolve(homedir(), "Library/Preferences/.wrangler/config/default.toml")
      : resolve(homedir(), ".wrangler/config/default.toml");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/oauth_token\s*=\s*"([^"]+)"/);
  return m?.[1] || null;
}

const API_TOKEN = env("CLOUDFLARE_API_TOKEN") || wranglerToken();
let ACCOUNT_ID = env("CLOUDFLARE_ACCOUNT_ID");

// --- read vars out of the unified config -----------------------------------
const raw = readFileSync(wranglerPath, "utf8");
const jsonBody = raw.slice(raw.indexOf("{"));
const cfg = JSON.parse(
  jsonBody.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""),
);
const vars = cfg.vars || {};
const WORKER_NAME = cfg.name;
const D1_NAME = vars.D1_DATABASE_NAME || "devarts-mail";
const PRIMARY = vars.PRIMARY_ADDRESS;
const DOMAIN = vars.MAIL_DOMAIN;

// All addresses routed to the worker: primary + EXTRA_IDENTITIES
// ("addr=Display Name;addr2=Name2"). EXTRA_IDENTITIES is a secret —
// comes from env / .dev.vars, never from the committed config.
const EXTRA_IDENTITIES = env("EXTRA_IDENTITIES") || "";
const ADDRESSES = [
  PRIMARY,
  ...EXTRA_IDENTITIES.split(";")
    .map((p) => p.split("=")[0].trim().toLowerCase())
    .filter(Boolean),
].filter((a, i, arr) => a && arr.indexOf(a) === i);

const run = (cmd, opts = {}) =>
  execSync(cmd, {
    cwd: root,
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
    ...opts,
  });

console.log("== devarts-mail setup ==");

// Resolve account id from API if not provided (needs a token of some kind).
const cfRaw = async (method, path, body) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!j.success) throw new Error(`${path}: ${JSON.stringify(j.errors)}`);
  return j.result;
};

if (!ACCOUNT_ID && API_TOKEN) {
  const accounts = await cfRaw("GET", "/accounts");
  ACCOUNT_ID = accounts?.[0]?.id;
  if (ACCOUNT_ID) console.log(`-> account: ${accounts[0].name} (${ACCOUNT_ID})`);
}

// --- 1. D1 database ----------------------------------------------------------
let dbId = cfg.d1_databases?.[0]?.database_id;
if (!dbId || dbId === "REPLACE_WITH_D1_DATABASE_ID") {
  console.log(`-> creating D1 database "${D1_NAME}"`);
  try {
    const out = run(`npx wrangler d1 create ${D1_NAME}`);
    const m =
      out.match(/database_id\s*[:=]\s*"?([0-9a-f-]{36})"?/i) ||
      out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (!m) throw new Error("could not parse database_id from wrangler output");
    dbId = m[1];
  } catch (e) {
    // DB may already exist — look it up
    const out = run(`npx wrangler d1 list`);
    const m =
      out.match(new RegExp(`([0-9a-f-]{36})[^\\n]*${D1_NAME}`)) ||
      run(`npx wrangler d1 info ${D1_NAME}`).match(/([0-9a-f-]{36})/);
    if (!m) throw e;
    dbId = m[1];
  }
  writeFileSync(
    wranglerPath,
    raw.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${dbId}"`),
  );
  console.log(`   database_id = ${dbId} (written to wrangler.jsonc)`);
} else {
  console.log(`-> D1 already configured (${dbId})`);
}

// --- 2. migrations -----------------------------------------------------------
console.log("-> applying migrations (remote)");
run(`npx wrangler d1 migrations apply ${D1_NAME} --remote`);

// --- 3. secrets ----------------------------------------------------------------
const SECRET_KEYS = ["UI_PASSWORD", "SESSION_SECRET", "EXTRA_IDENTITIES"];
for (const key of SECRET_KEYS) {
  const val = env(key);
  if (!val) {
    console.log(`   ! ${key} not set — add to .dev.vars or env`);
    continue;
  }
  execFileSync("npx", ["wrangler", "secret", "put", key, "--name", WORKER_NAME], {
    cwd: root,
    input: val,
    stdio: ["pipe", "inherit", "inherit"],
  });
  console.log(`   secret ${key} set`);
}

// --- 4. deploy -------------------------------------------------------------------
console.log("-> deploying worker");
run(`npx wrangler deploy`);

// --- 5. email routing rule --------------------------------------------------------
if (API_TOKEN) {
  console.log(`-> configuring Email Routing for ${ADDRESSES.join(", ")}`);
  const cf = cfRaw;
  const zones = await cf("GET", `/zones?name=${DOMAIN}`);
  const zoneId = zones?.[0]?.id;
  if (!zoneId) throw new Error(`zone not found for ${DOMAIN}`);

  // ensure Email Routing is enabled on the zone
  try {
    await cf("POST", `/zones/${zoneId}/email/routing/enable`);
  } catch {}
  await cf("PUT", `/zones/${zoneId}/email/routing`, { enabled: true }).catch(() => {});

  const rules = await cf("GET", `/zones/${zoneId}/email/routing/rules`);
  for (const addr of ADDRESSES) {
    const existing = rules.find(
      (r) => r.matchers?.[0]?.value?.toLowerCase() === addr.toLowerCase(),
    );
    if (existing) {
      await cf("PUT", `/zones/${zoneId}/email/routing/rules/${existing.tag}`, {
        ...existing,
        enabled: true,
        actions: [{ type: "worker", value: [WORKER_NAME] }],
      });
      console.log(`   updated existing rule ${addr} -> worker "${WORKER_NAME}"`);
    } else {
      await cf("POST", `/zones/${zoneId}/email/routing/rules`, {
        name: `${WORKER_NAME}: ${addr}`,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: addr }],
        actions: [{ type: "worker", value: [WORKER_NAME] }],
      });
      console.log(`   created rule ${addr} -> worker "${WORKER_NAME}"`);
    }
  }
  console.log("   (contact@ rules left untouched)");
} else {
  console.log("   ! no API token or wrangler login — skipped email routing setup.");
  console.log(`     Manually: Dashboard -> ${DOMAIN} -> Email Routing -> Rules ->`);
  for (const addr of ADDRESSES)
    console.log(`     ${addr} -> Send to Worker -> ${WORKER_NAME}`);
}

console.log("\nDone. Open https://" + WORKER_NAME + ".<subdomain>.workers.dev");
console.log("(custom domain route is live if configured in wrangler.jsonc)");
