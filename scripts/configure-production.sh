#!/usr/bin/env bash
# =============================================================================
# Configure and deploy production.
#
#   ./scripts/configure-production.sh
#
# Links your Vercel project, disables deployment protection, generates every
# secret that can be generated, builds and VERIFIES the database connection,
# applies schema + migrations, seeds, deploys, and runs the acceptance test.
#
# It asks you for the Supabase database password (hidden input) and, if not yet
# configured, the Google OAuth client id/secret. Nothing you type is printed,
# logged, or committed.
#
# WHY IT NO LONGER USES `vercel env pull` FOR THE DATABASE:
#   Vercel marks these variables Sensitive and `env pull` writes the literal
#   string [SENSITIVE] instead of the value. Sourcing that gave the seed step
#   DATABASE_URL="[SENSITIVE]", which pg-connection-string parses via its libpq
#   fallback into host "base" — the cause of `getaddrinfo ENOTFOUND base`.
#   The URL is now held in this shell and verified against the real database
#   BEFORE it is written anywhere.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

SUPABASE_REF="${SUPABASE_REF:-njiwtuvwujooanyznyty}"
# The intended production project. The script refuses to configure anything
# else unless you override it, because an earlier run silently configured a
# different project that happened to be visible to the signed-in account.
EXPECT_PROJECT="${EXPECT_PROJECT:-auto-agent}"
LOCAL_DB_FILE=".env.db.local"        # gitignored; lets re-runs skip the prompt

say()  { printf "\n\033[1m==> %s\033[0m\n" "$1"; }
ok()   { printf "    \033[32m%s\033[0m\n" "$1"; }
warn() { printf "    \033[33m%s\033[0m\n" "$1"; }
die()  { printf "\n\033[31m%s\033[0m\n\n" "$1"; exit 1; }
sanitize() { sed -E 's|://([^:/@]+):[^@]*@|://\1:***@|g'; }

# ---------------------------------------------------------------- 1. account -
say "1/9  Vercel account"
WHO=$(npx vercel whoami 2>/dev/null | tail -1)
if [ -z "${WHO:-}" ]; then
  warn "Not signed in — a browser window will open."
  npx vercel login || die "vercel login failed."
  WHO=$(npx vercel whoami 2>/dev/null | tail -1)
fi
ok "signed in as $WHO"

# ------------------------------------------------------------------- 2. link -
say "2/9  Project"
if [ ! -f .vercel/project.json ]; then
  echo "    Choose the scope and project you want to deploy to."
  npx vercel link || die "vercel link failed."
fi
PROJECT=$(python3 -c "import json;print(json.load(open('.vercel/project.json'))['projectName'])")
ok "linked to: $PROJECT"
if [ "$PROJECT" != "$EXPECT_PROJECT" ]; then
  rm -rf .vercel
  die "Linked to '$PROJECT', but the intended production project is '$EXPECT_PROJECT'.
Nothing was configured and the link has been removed.

If you are signed in to the wrong Vercel account:
  npx vercel logout && npx vercel login     (sign in as the owner of $EXPECT_PROJECT)
  ./scripts/configure-production.sh

If '$PROJECT' really is the target, re-run with:
  EXPECT_PROJECT=$PROJECT ./scripts/configure-production.sh"
fi

# ------------------------------------------------------------- 3. protection -
say "3/9  Public reachability"
if npx vercel project protection disable --sso >/dev/null 2>&1; then
  ok "deployment protection: off"
else
  warn "could not change protection from the CLI. If the site redirects to"
  warn "vercel.com/sso-api, turn it off at Settings -> Deployment Protection."
fi

# ---------------------------------------------------------------- 4. secrets -
say "4/9  Generated secrets"
EXISTING=$(npx vercel env ls production 2>/dev/null || true)
has() { echo "$EXISTING" | grep -q "[[:space:]]$1[[:space:]]"; }
gen()  { node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; }
for KEY in SESSION_SECRET TOKEN_ENCRYPTION_KEY CRON_SECRET INGEST_TOKEN; do
  if has "$KEY"; then ok "$KEY already set"
  else printf "%s" "$(gen)" | npx vercel env add "$KEY" production --force >/dev/null 2>&1 \
         && ok "$KEY generated"; fi
done
if has APP_PASSWORD; then ok "APP_PASSWORD already set"; else
  PW=$(node -e "
    const w=['harbour','lantern','copper','meadow','falcon','granite','willow','ember'];
    const r=()=>w[require('crypto').randomInt(w.length)];
    console.log([r(),r(),r()].join('-')+'-'+require('crypto').randomInt(1000,9999));")
  printf "%s" "$PW" | npx vercel env add APP_PASSWORD production --force >/dev/null 2>&1
  echo "$PW" > .app-password.txt && chmod 600 .app-password.txt
  ok "APP_PASSWORD generated -> ./.app-password.txt"
fi

# --------------------------------------------------------------- 5. database -
say "5/9  Database connection"
DBURL=""
# Re-use a previously VERIFIED url if we stored one. Never trust `env pull`
# here: Sensitive variables come back as the literal string [SENSITIVE].
if [ -f "$LOCAL_DB_FILE" ]; then
  DBURL=$(grep -m1 '^DATABASE_URL=' "$LOCAL_DB_FILE" | cut -d= -f2-)
  if node scripts/db-url.mjs verify "$DBURL" >/dev/null 2>&1; then
    ok "re-using the verified connection from $LOCAL_DB_FILE"
  else
    warn "stored connection no longer works — asking again"
    DBURL=""
  fi
fi

while [ -z "$DBURL" ]; do
  echo
  echo "    Supabase database password for project $SUPABASE_REF"
  echo "    Don't have it? https://supabase.com/dashboard/project/$SUPABASE_REF/settings/database"
  echo "    -> Reset database password (nothing is connected yet, so this is safe)"
  echo
  printf "    Password (hidden, never printed): "
  read -r -s DBPASS; echo
  [ -n "$DBPASS" ] || die "No password entered."

  echo
  echo "      1) Transaction pooler, port 6543  (recommended)"
  echo "      2) Direct connection, port 5432   (works, fine for a demo)"
  printf "    Which? [2]: "
  read -r CHOICE
  if [ "${CHOICE:-2}" = "1" ]; then
    echo
    echo "    The pooler host is region-specific and shown in the Supabase"
    echo "    Connect panel, e.g. aws-0-ap-south-1.pooler.supabase.com"
    printf "    Pooler host: "
    read -r PHOST
    [ -n "$PHOST" ] || die "Pooler host required for option 1."
    DBURL=$(node scripts/db-url.mjs build "$SUPABASE_REF" "$DBPASS" pooler "$PHOST") || die "Could not build the URL."
  else
    DBURL=$(node scripts/db-url.mjs build "$SUPABASE_REF" "$DBPASS" direct) || die "Could not build the URL."
  fi
  unset DBPASS

  echo
  echo "    Verifying before writing anything:"
  if ! node scripts/db-url.mjs verify "$DBURL"; then
    warn "That connection did not work. Nothing was written to Vercel."
    DBURL=""
    printf "    Try again? [Y/n]: "; read -r AGAIN
    case "${AGAIN:-Y}" in [Nn]*) die "Stopped at your request.";; esac
  fi
done

printf "DATABASE_URL=%s\n" "$DBURL" > "$LOCAL_DB_FILE" && chmod 600 "$LOCAL_DB_FILE"
if has DATABASE_URL; then
  npx vercel env rm DATABASE_URL production --yes >/dev/null 2>&1
fi
printf "%s" "$DBURL" | npx vercel env add DATABASE_URL production --force >/dev/null 2>&1 \
  && ok "DATABASE_URL written to Vercel (verified working, value not printed)"

# ----------------------------------------------------------------- 6. google -
say "6/9  Google OAuth"
CALLBACK="https://$(echo "${PRODUCTION_URL:-auto-agent-nu.vercel.app}" | sed 's|https\?://||')/api/auth/google/callback"
for KEY in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  if has "$KEY"; then ok "$KEY already set (left untouched)"; else
    echo
    echo "    $KEY — Google Cloud -> APIs & Services -> Credentials"
    echo "    Authorised redirect URI must be exactly:"
    echo "      $CALLBACK"
    echo "    (press Enter to skip; password sign-in still works)"
    npx vercel env add "$KEY" production || warn "$KEY skipped"
  fi
done

# ------------------------------------------------------- 7. schema and seed --
say "7/9  Schema, migrations and master data"
DATABASE_URL="$DBURL" npm run seed || die "Seeding failed."
ok "database ready"

# ----------------------------------------------------------------- 8. deploy -
say "8/9  Build and deploy"
npm run build >/dev/null 2>&1 || die "Production build failed. Run 'npm run build' to see why."
ok "build OK"
DEPLOY_OUT=$(npx vercel --prod --yes 2>&1) || { echo "$DEPLOY_OUT" | tail -12 | sanitize; die "Deploy failed."; }
URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.vercel\.app' | tail -1)
ok "deployed: ${URL:-see the Vercel dashboard}"

# ----------------------------------------------------------------- 9. verify -
say "9/9  Verifying production"
./scripts/verify-production.sh "${URL:-https://$PROJECT.vercel.app}"

echo
echo "-----------------------------------------------------------"
echo "  Open the URL above and click 'Continue with Google'."
echo "  Team password (if you need it): ./.app-password.txt"
echo "-----------------------------------------------------------"
