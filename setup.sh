#!/bin/bash
# LolaDesk — Quick Start Guide for Local Development
# ═══════════════════════════════════════════════════════════════════════

set -e

echo "🔧 LolaDesk Setup — Local Development"
echo "═══════════════════════════════════════════════════════════════════════"

# 1. Check prerequisites
echo ""
echo "📋 Checking prerequisites…"
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Install from https://www.docker.com/products/docker-desktop"
    exit 1
fi
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose not found. Install from https://docs.docker.com/compose/install/"
    exit 1
fi
echo "✓ Docker and Docker Compose installed"

# 2. Copy env file
echo ""
echo "🔐 Environment setup…"
if [ ! -f .env.local ]; then
    cp .env.example .env.local
    echo "✓ Created .env.local (IMPORTANT: Fill in your API keys)"
    echo ""
    echo "⚠️  Edit .env.local and add:"
    echo "   • TELNYX_API_KEY (for voice/SMS)"
    echo "   • ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID (for Lola's voice)"
    echo "   • SUPABASE_SERVICE_ROLE_KEY (for database)"
    echo "   • STRIPE_API_KEY (optional, for payments)"
    echo ""
    echo "Then run: docker-compose up"
    exit 0
else
    echo "✓ .env.local already exists"
fi

# 3. Check if env vars are filled
echo ""
echo "🔍 Verifying environment variables…"
MISSING=()
for VAR in TELNYX_API_KEY ELEVENLABS_API_KEY ELEVENLABS_VOICE_ID SUPABASE_SERVICE_ROLE_KEY; do
    if ! grep -q "^${VAR}=[a-zA-Z0-9_-]" .env.local; then
        MISSING+=("$VAR")
    fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "⚠️  Missing API keys in .env.local:"
    for VAR in "${MISSING[@]}"; do
        echo "   • $VAR"
    done
    echo ""
    echo "Run: docker-compose up"
    echo "   (Lola will work in fallback mode without these keys)"
    echo ""
fi

# 4. Install dependencies
echo ""
echo "📦 Installing Node dependencies…"
if [ ! -d "node_modules" ]; then
    npm ci
else
    echo "✓ node_modules already present"
fi

# 5. Start services
echo ""
echo "🚀 Starting LolaDesk on Docker…"
docker-compose up -d

# Wait for services
echo ""
echo "⏳ Waiting for services to start…"
sleep 5

# 6. Initialize database
echo ""
echo "📊 Initializing Supabase database…"
docker-compose exec -T supabase pg_isready -U postgres > /dev/null 2>&1 || {
    echo "   Postgres still starting… waiting…"
    sleep 10
}

# 7. Run vercel dev
echo ""
echo "✨ Starting Vercel dev server…"
docker-compose exec app npm run dev > /dev/null 2>&1 &

# 8. Summary
echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "✅ LolaDesk is running!"
echo ""
echo "🌐 URLs:"
echo "   • Dashboard:    http://localhost:3000/dashboard.html"
echo "   • Marketing:    http://localhost:3000"
echo "   • Adminer (DB): http://localhost:8081"
echo ""
echo "📊 Services:"
echo "   • App:          http://localhost:3000"
echo "   • Postgres:     localhost:5432"
echo ""
echo "🧩 API Endpoints:"
echo "   • Lola Chat:    http://localhost:3000/api/lola"
echo "   • Voice Calls:  http://localhost:3000/api/telnyx-voice"
echo "   • SMS:          http://localhost:3000/api/telnyx-sms"
echo ""
echo "📝 Logs:"
echo "   docker-compose logs -f app"
echo "   docker-compose logs -f supabase"
echo ""
echo "🛑 Stop:"
echo "   docker-compose down"
echo ""
echo "═══════════════════════════════════════════════════════════════════════"
