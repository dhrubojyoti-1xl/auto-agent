#!/usr/bin/env bash
# =============================================================================
# Finishes the production deployment once DATABASE_URL exists in Vercel.
#
#   ./scripts/finish-deploy.sh
#
# It pulls the production environment from Vercel, applies the schema, seeds
# master data, redeploys, and runs the acceptance test. Idempotent: safe to run
# again at any time.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pulling production environment from Vercel"
npx vercel env pull .env.production.local --environment=production --yes >/dev/null
# shellcheck disable=SC1091
set -a; source .env.production.local; set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set in the Vercel production environment."
  echo "Add it (Settings -> Environment Variables) or install the Supabase"
  echo "integration, then run this script again."
  exit 1
fi
echo "    DATABASE_URL found (value not printed)"

echo "==> Applying schema and seeding master data"
npm run seed

echo "==> Redeploying"
npx vercel --prod --yes >/dev/null
echo "    deployed"

echo "==> Verifying"
./scripts/verify-production.sh
