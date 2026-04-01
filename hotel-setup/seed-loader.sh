#!/usr/bin/env bash
#
# seed-loader.sh - Load seed data into the Hotel Concierge knowledge base
#
# Uploads all text files from seed-data/ to the hotel-concierge admin API.
# Requires: curl, the gateway must be running with a valid token.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_DIR="${SCRIPT_DIR}/seed-data"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:18789}"
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"

if [ -z "$GATEWAY_TOKEN" ]; then
  echo "ERROR: OPENCLAW_GATEWAY_TOKEN is not set."
  echo "Usage: OPENCLAW_GATEWAY_TOKEN=your-token ./seed-loader.sh"
  exit 1
fi

# Category mapping based on filename
get_category() {
  local filename="$1"
  case "$filename" in
    hotel-info*) echo "hotel_info" ;;
    faq*) echo "faq" ;;
    restaurant*|dining*) echo "dining" ;;
    event*) echo "events" ;;
    transport*|anreise*) echo "transport" ;;
    wasserburg*|sehens*|ausflug*) echo "local" ;;
    *) echo "other" ;;
  esac
}

echo "============================================"
echo "  Hotel Concierge - Seed Data Loader"
echo "============================================"
echo ""
echo "Gateway: $GATEWAY_URL"
echo "Seed dir: $SEED_DIR"
echo ""

# Check if gateway is reachable
if ! curl -sf "${GATEWAY_URL}/healthz" > /dev/null 2>&1; then
  echo "ERROR: Gateway not reachable at ${GATEWAY_URL}"
  echo "Make sure the containers are running: docker compose -f docker-compose.hotel.yml ps"
  exit 1
fi

echo "Gateway is healthy."
echo ""

# Upload each file
uploaded=0
failed=0

for filepath in "${SEED_DIR}"/*.txt "${SEED_DIR}"/*.md "${SEED_DIR}"/*.csv "${SEED_DIR}"/*.pdf; do
  [ -f "$filepath" ] || continue

  filename="$(basename "$filepath")"
  category="$(get_category "$filename")"

  echo -n "Uploading: $filename (category: $category) ... "

  response=$(curl -sf \
    -X POST \
    -H "Authorization: Bearer ${GATEWAY_TOKEN}" \
    -F "file=@${filepath}" \
    -F "category=${category}" \
    "${GATEWAY_URL}/concierge/admin/upload" 2>&1) || {
      echo "FAILED"
      echo "  Response: $response"
      failed=$((failed + 1))
      continue
    }

  # Check if response contains success
  if echo "$response" | grep -q '"success":true'; then
    chunks=$(echo "$response" | grep -o '"chunks":[0-9]*' | grep -o '[0-9]*')
    echo "OK (${chunks:-?} chunks)"
    uploaded=$((uploaded + 1))
  else
    echo "FAILED"
    echo "  Response: $response"
    failed=$((failed + 1))
  fi
done

echo ""
echo "============================================"
echo "  Done: $uploaded uploaded, $failed failed"
echo "============================================"
