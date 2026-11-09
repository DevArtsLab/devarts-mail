#!/usr/bin/env bash
# ============================================================
# devarts-mail — one-command install
#
#   git clone <repo> && cd devarts-mail && ./install.sh
#
# Does: pnpm install -> .dev.vars (generated secrets) ->
#       wrangler login (if needed) -> full setup (D1, migrations,
#       secrets, deploy, email routing rule).
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }

bold "== devarts-mail installer =="

# --- 0. prerequisites -------------------------------------------------------
command -v node >/dev/null || { echo "node is required (https://nodejs.org)"; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required (https://pnpm.io)"; exit 1; }
green "node $(node -v) / pnpm $(pnpm -v)"

# --- 1. deps ----------------------------------------------------------------
bold "-> pnpm install"
pnpm install

# --- 2. .dev.vars (local secrets; generated if missing) ----------------------
if [ ! -f .dev.vars ]; then
  bold "-> generating .dev.vars"
  rand() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
  {
    echo "UI_PASSWORD=$(rand 12)"
    echo "SESSION_SECRET=$(rand 32)"
    echo "# Optional: needed only if you don't 'wrangler login'"
    echo "# CLOUDFLARE_API_TOKEN="
    echo "# CLOUDFLARE_ACCOUNT_ID="
  } > .dev.vars
  green "   .dev.vars created (gitignored)"
  echo "   UI_PASSWORD = $(grep UI_PASSWORD .dev.vars | cut -d= -f2)  <- your web UI password"
else
  green "-> .dev.vars exists"
fi

# --- 3. Cloudflare auth ------------------------------------------------------
if pnpm exec wrangler whoami >/dev/null 2>&1 && ! pnpm exec wrangler whoami 2>&1 | grep -q "not authenticated"; then
  green "-> wrangler authenticated"
else
  warn "-> launching wrangler login (a browser window will open)"
  pnpm exec wrangler login
fi

# --- 4. provision + deploy ----------------------------------------------------
bold "-> running setup (D1 + migrations + secrets + deploy + routing)"
pnpm run setup

# --- 5. done ------------------------------------------------------------------
bold ""
green "✔ devarts-mail is live"
echo "  UI       : https://mail.devartslab.com  (or workers.dev URL above)"
echo "  Password : $(grep UI_PASSWORD .dev.vars | cut -d= -f2)"
echo "  Config   : wrangler.jsonc  |  Secrets: .dev.vars / wrangler secrets"
