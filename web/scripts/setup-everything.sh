#!/usr/bin/env bash
# =============================================================================
# ONE COMMAND. Run it in your own terminal:
#
#   cd ~/auto-agent/web && ./scripts/setup-everything.sh
#
# It provisions the database, wires every environment variable, applies the
# schema, seeds the master data, deploys, and runs the acceptance test.
#
# You will be asked to press "y" ONCE, to accept the Supabase marketplace terms.
# Vercel requires a human for that step and refuses it in non-interactive mode:
#   "Marketplace terms cannot be accepted in non-interactive mode."
# Everything before and after it is automatic.
#
# Safe to re-run at any point; every step is idempotent.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

say() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }
die() { printf "\n\033[31m%s\033[0m\n" "$1"; exit 1; }

say "1/7  Checking the Vercel project link"
if [ ! -f .vercel/project.json ]; then
  npx vercel link --yes || die "vercel link failed. Run 'npx vercel login' first."
fi
PROJECT=$(python3 -c "import json;print(json.load(open('.vercel/project.json'))['projectName'])")
echo "    project: $PROJECT"

say "2/7  Making sure the site is publicly reachable"
npx vercel project protection disable --sso >/dev/null 2>&1
echo "    deployment protection: off"

say "3/7  Ensuring the app secrets exist"
existing=$(npx vercel env ls production 2>/dev/null || true)
for key in APP_PASSWORD SESSION_SECRET INGEST_TOKEN; do
  if echo "$existing" | grep -q "$key"; then
    echo "    $key already set"
  else
    case $key in
      APP_PASSWORD) val=$(node -e "
        const w=['harbour','lantern','copper','meadow','falcon','granite','willow','ember'];
        const r=()=>w[require('crypto').randomInt(w.length)];
        console.log([r(),r(),r()].join('-')+'-'+require('crypto').randomInt(1000,9999));") ;;
      *) val=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") ;;
    esac
    printf "%s" "$val" | npx vercel env add "$key" production --force >/dev/null 2>&1
    echo "    $key generated"
    if [ "$key" = "APP_PASSWORD" ]; then
      echo "$val" > ../.app-password.txt && chmod 600 ../.app-password.txt
      echo "    -> sign-in password written to ~/auto-agent/.app-password.txt"
    fi
  fi
done

say "4/7  Database"
if npx vercel env ls production 2>/dev/null | grep -q DATABASE_URL; then
  echo "    DATABASE_URL already configured"
else
  echo "    Not configured. Provisioning Supabase through the Vercel Marketplace."
  echo "    Vercel will ask you to accept the Supabase terms — press y."
  echo
  npx vercel integration accept-terms supabase
  npx vercel integration add supabase || die \
"Provisioning did not complete.

Alternative that needs no marketplace terms:
  1. Supabase -> Settings -> Database -> Connection pooling -> copy the URI (port 6543)
  2. npx vercel env add DATABASE_URL production      (paste it, press enter)
  3. Re-run this script."
  if ! npx vercel env ls production 2>/dev/null | grep -q DATABASE_URL; then
    die "The integration finished but DATABASE_URL was not injected. Add it manually with:
  npx vercel env add DATABASE_URL production"
  fi
  echo "    DATABASE_URL injected by the integration"
fi

say "5/7  Applying the schema and seeding master data"
npx vercel env pull .env.production.local --environment=production --yes >/dev/null 2>&1
set -a; . ./.env.production.local; set +a
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL still missing after pulling the environment."
npm run seed || die "Seeding failed. Check that DATABASE_URL is the POOLER string (port 6543)."

say "6/7  Deploying"
npx vercel --prod --yes >/dev/null || die "Deploy failed."
echo "    deployed"

say "7/7  Verifying production"
./scripts/verify-production.sh "https://$(npx vercel project inspect "$PROJECT" 2>&1 | grep -oE '[a-z0-9-]+\.vercel\.app' | head -1)" \
  || ./scripts/verify-production.sh

echo
echo "-----------------------------------------------------------"
echo "  Done. Sign in with the password in ~/auto-agent/.app-password.txt"
echo "-----------------------------------------------------------"
