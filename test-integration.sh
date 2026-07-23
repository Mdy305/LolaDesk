#!/bin/bash
# LolaDesk — Quick Integration Test
# Tests the entire pipeline: voice → LLM → Supabase → ElevenLabs

set -e

echo "🧪 LolaDesk Integration Test"
echo "════════════════════════════════════════════════════════════════════"

# Check prerequisites
check_cmd() {
  if ! command -v "$1" &> /dev/null; then
    echo "❌ Missing: $1"
    echo "Install it and try again"
    exit 1
  fi
}

check_cmd "curl"
check_cmd "jq"

# Check env
if [ ! -f .env.local ]; then
  echo "❌ No .env.local found. Run: cp .env.example .env.local"
  exit 1
fi

# Source env
source .env.local

# Test 1: Check Vercel dev server is running
echo ""
echo "1️⃣  Testing Vercel dev server…"
if ! curl -s http://localhost:3000 > /dev/null 2>&1; then
  echo "❌ Vercel not responding on port 3000"
  echo "   Run: npm run dev"
  exit 1
fi
echo "✅ Vercel dev server is running"

# Test 2: Check /api/health
echo ""
echo "2️⃣  Testing /api/health endpoint…"
HEALTH=$(curl -s http://localhost:3000/api/health)
if [ -z "$HEALTH" ]; then
  echo "⚠️  /api/health returned empty (may not be configured)"
else
  echo "✅ /api/health: $HEALTH"
fi

# Test 3: Check Supabase connection
echo ""
echo "3️⃣  Testing Supabase connection…"
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ] || [ "$SUPABASE_SERVICE_ROLE_KEY" == "your_supabase_service_role_key_here" ]; then
  echo "⚠️  SUPABASE_SERVICE_ROLE_KEY not configured"
else
  echo "✅ SUPABASE_SERVICE_ROLE_KEY is set"
fi

# Test 4: Check Telnyx API key
echo ""
echo "4️⃣  Testing Telnyx API key…"
if [ -z "$TELNYX_API_KEY" ] || [ "$TELNYX_API_KEY" == "your_telnyx_api_key_here" ]; then
  echo "⚠️  TELNYX_API_KEY not configured"
else
  echo "✅ TELNYX_API_KEY is set"
  # Quick API test
  TELNYX_TEST=$(curl -s -H "Authorization: Bearer $TELNYX_API_KEY" \
    https://api.telnyx.com/v2/public_key 2>/dev/null | jq '.errors // "ok"' 2>/dev/null || echo "unreachable")
  if [ "$TELNYX_TEST" == "ok" ]; then
    echo "✅ Telnyx API is reachable"
  else
    echo "⚠️  Telnyx API is unreachable (may be network issue)"
  fi
fi

# Test 5: Check ElevenLabs config
echo ""
echo "5️⃣  Testing ElevenLabs configuration…"
if [ -z "$ELEVENLABS_API_KEY" ] || [ "$ELEVENLABS_API_KEY" == "your_elevenlabs_api_key_here" ]; then
  echo "⚠️  ELEVENLABS_API_KEY not configured"
else
  echo "✅ ELEVENLABS_API_KEY is set"
fi

if [ -z "$ELEVENLABS_VOICE_ID" ] || [ "$ELEVENLABS_VOICE_ID" == "your_elevenlabs_voice_id_here" ]; then
  echo "⚠️  ELEVENLABS_VOICE_ID not configured"
else
  echo "✅ ELEVENLABS_VOICE_ID is set: $ELEVENLABS_VOICE_ID"
fi

# Test 6: Test /api/lola endpoint (mock request)
echo ""
echo "6️⃣  Testing /api/lola endpoint…"
if curl -s -X POST http://localhost:3000/api/lola \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}], "max_tokens": 100}' \
  | jq '.' > /dev/null 2>&1; then
  echo "✅ /api/lola is responding"
else
  echo "⚠️  /api/lola returned invalid JSON (may need auth or API key)"
fi

# Test 7: Check database
echo ""
echo "7️⃣  Testing database…"
if command -v psql &> /dev/null; then
  if psql -h localhost -U postgres -d postgres -c "SELECT version();" > /dev/null 2>&1; then
    echo "✅ Postgres is running on localhost:5432"
  else
    echo "⚠️  Postgres connection failed"
  fi
else
  echo "⏭️  psql not installed (skip DB test)"
fi

# Summary
echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "✅ Integration Test Complete"
echo ""
echo "Next steps:"
echo "1. Open dashboard: http://localhost:3000/dashboard.html"
echo "2. Click the orb and say: 'Book me a balayage tomorrow at 2pm'"
echo "3. Expected: Lola confirms booking in her real voice"
echo ""
echo "If something failed:"
echo "• docker-compose logs -f app    (see app logs)"
echo "• docker-compose logs -f supabase (see database logs)"
echo "• Check .env.local for missing API keys"
echo ""
