#!/usr/bin/env bash
# =============================================================================
# Production acceptance test. Read-only apart from one throwaway import that it
# reports on but does not clean up (nothing is written unless you pass --write).
#
#   ./scripts/verify-production.sh [url]
# =============================================================================
set -uo pipefail
URL="${1:-https://auto-agent-reporting.vercel.app}"
PASS=0; FAIL=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then printf "  PASS  %-46s %s\n" "$1" "$3"; PASS=$((PASS+1));
  else printf "  FAIL  %-46s expected %s, got %s\n" "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$@"; }

echo "Verifying $URL"
echo
echo "AVAILABILITY"
HEALTH=$(curl -s --max-time 25 "$URL/api/health")
check "health endpoint reachable" "true" \
  "$(echo "$HEALTH" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["ok"]).lower())' 2>/dev/null || echo false)"
echo "  $(echo "$HEALTH" | python3 -c 'import json,sys;print(json.load(sys.stdin)["checks"])' 2>/dev/null || echo "$HEALTH")"

echo
echo "SECURITY — private APIs must reject anonymous callers"
for p in preview commit rebuild report; do
  check "POST /api/$p" "401" "$(code -X POST "$URL/api/$p" -H 'content-type: application/json' -d '{}')"
done
check "POST /api/ingest without a token" "401" \
  "$(code -X POST "$URL/api/ingest" -H 'content-type: application/json' -d '{"text":"x"}')"
check "POST /api/login with a wrong password" "401" \
  "$(code -X POST "$URL/api/login" -H 'content-type: application/json' -d '{"password":"definitely-not-it"}')"

echo
echo "SECURITY — pages must redirect, not render"
for p in "" quality repeats slow report submit; do
  check "GET /$p redirects to login" "307" "$(code "$URL/$p")"
done

echo
echo "SECURITY — no secret may appear in the delivered HTML or JS"
BODY=$(curl -s --max-time 25 "$URL/login")
for pat in APP_PASSWORD SESSION_SECRET INGEST_TOKEN ANTHROPIC_API_KEY DATABASE_URL postgres://; do
  if echo "$BODY" | grep -qi -- "$pat"; then
    printf "  FAIL  %-46s found in page source\n" "$pat"; FAIL=$((FAIL+1))
  else
    printf "  PASS  %-46s absent\n" "$pat"; PASS=$((PASS+1))
  fi
done

echo
echo "-----------------------------------------------------------"
echo "  $PASS passed, $FAIL failed"
echo "-----------------------------------------------------------"
[ "$FAIL" -eq 0 ]
