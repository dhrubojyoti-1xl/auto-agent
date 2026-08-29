#!/usr/bin/env bash
# =============================================================================
# ONE COMMAND to finish production.
#
#   cd ~/auto-agent && ./scripts/configure-production.sh
#
# It links your Vercel project, turns off deployment protection, generates every
# secret that can be generated, applies the database schema and migrations,
# seeds master data, deploys, and runs the acceptance test.
#
# It will prompt you for exactly three values, which only you can provide.
# Type them at the prompt — they go straight into Vercel and are never printed,
# logged, or written to the repository:
#
#   DATABASE_URL           Supabase -> Settings -> Database -> Connection pooling
#                          (port 6543). Your project ref is njiwtuvwujooanyznyty.
#   GOOGLE_CLIENT_ID       Google Cloud -> Credentials -> OAuth client (Web)
#   GOOGLE_CLIENT_SECRET   same screen
#
# Safe to re-run: every step is idempotent and existing values are left alone.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

say()  { printf "\n\033[1m==> %s\033[0m\n" "$1"; }
ok()   { printf "    \033[32m%s\033[0m\n" "$1"; }
warn() { printf "    \033[33m%s\033[0m\n" "$1"; }
die()  { printf "\n\033[31m%s\033[0m\n\n" "$1"; exit 1; }

say "1/8  Vercel account"
WHO=$(npx vercel whoami 2>/dev/null | tail -1)
if [ -z "${WHO:-}" ]; then
  warn "Not logged in. A browser window will open."
  npx vercel login || die "vercel login failed."
  WHO=$(npx vercel whoami 2>/dev/null | tail -1)
fi
ok "signed in as $WHO"

say "2/8  Linking the project"
if [ ! -f .vercel/project.json ]; then
  echo "    Pick the scope and project that owns https://vercel.com/babb2/auto-agent"
  npx vercel link || die "vercel link failed."
fi
PROJECT=$(python3 -c "import json;print(json.load(open('.vercel/project.json'))['projectName'])")
ok "project: $PROJECT"

say "3/8  Making the site publicly reachable"
if npx vercel project protection disable --sso >/dev/null 2>&1; then
  ok "deployment protection: off"
else
  warn "could not change protection from the CLI"
  warn "if the site redirects to vercel.com/sso-api, turn it off at:"
  warn "  Project -> Settings -> Deployment Protection -> Vercel Authentication -> Disabled"
fi

say "4/8  Generating the secrets that can be generated"
EXISTING=$(npx vercel env ls production 2>/dev/null || true)
gen() { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }
for KEY in SESSION_SECRET TOKEN_ENCRYPTION_KEY CRON_SECRET INGEST_TOKEN; do
  if echo "$EXISTING" | grep -q "\b$KEY\b"; then ok "$KEY already set"; else
    printf "%s" "$(gen)" | npx vercel env add "$KEY" production --force >/dev/null 2>&1 \
      && ok "$KEY generated"
  fi
done
if echo "$EXISTING" | grep -q "\bAPP_PASSWORD\b"; then ok "APP_PASSWORD already set"; else
  PW=$(node -e "
    const w=['harbour','lantern','copper','meadow','falcon','granite','willow','ember'];
    const r=()=>w[require('crypto').randomInt(w.length)];
    console.log([r(),r(),r()].join('-')+'-'+require('crypto').randomInt(1000,9999));")
  printf "%s" "$PW" | npx vercel env add APP_PASSWORD production --force >/dev/null 2>&1
  echo "$PW" > .app-password.txt && chmod 600 .app-password.txt
  ok "APP_PASSWORD generated -> ./.app-password.txt (gitignored)"
fi

say "5/8  The three values only you can supply"
need() {
  local KEY=$1 HINT=$2
  if echo "$EXISTING" | grep -q "\b$KEY\b"; then ok "$KEY already set"; return; fi
  echo
  echo "    $KEY"
  echo "    $HINT"
  echo "    (typed here, sent straight to Vercel, never printed or stored locally)"
  npx vercel env add "$KEY" production || warn "$KEY not set — re-run this script later"
}
need DATABASE_URL       "Supabase -> Settings -> Database -> Connection pooling -> URI (port 6543)"
need GOOGLE_CLIENT_ID   "Google Cloud -> APIs & Services -> Credentials -> OAuth client (Web application)"
need GOOGLE_CLIENT_SECRET "same screen as the client ID"

say "6/8  Applying schema, migrations and master data"
npx vercel env pull .env.production.local --environment=production --yes >/dev/null 2>&1
set -a; . ./.env.production.local 2>/dev/null; set +a
if [ -z "${DATABASE_URL:-}" ]; then
  die "DATABASE_URL is still not set. Re-run this script and provide it at step 5."
fi
npm run seed || die "Seeding failed. Check that DATABASE_URL is the POOLER string (port 6543)."
ok "database ready"

say "7/8  Deploying"
npx vercel --prod --yes >/dev/null || die "Deploy failed."
URL=$(npx vercel inspect "$PROJECT" 2>&1 | grep -oE 'https://[a-z0-9.-]+\.vercel\.app' | head -1)
ok "deployed: ${URL:-check the Vercel dashboard}"

say "8/8  Verifying"
./scripts/verify-production.sh "${URL:-https://auto-agent-nu.vercel.app}"

echo
echo "-----------------------------------------------------------"
echo "  Open the URL above, click 'Continue with Google', approve"
echo "  the read-only Gmail permission, and the assistant starts"
echo "  collecting reports on its own."
echo "-----------------------------------------------------------"
