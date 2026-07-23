#!/bin/bash
# LolaDesk Deployment to Vercel with all wiring
# ════════════════════════════════════════════════════════════════════════

set -e

echo "🚀 LolaDesk — Vercel Deployment Script"
echo "════════════════════════════════════════════════════════════════════════"

# Check for Vercel CLI
if ! command -v vercel &> /dev/null; then
    echo "📦 Installing Vercel CLI…"
    npm install -g vercel
fi

# Link to project
echo ""
echo "🔗 Linking to Vercel project…"
vercel link --confirm

# Set environment variables
echo ""
echo "🔐 Setting environment variables…"
echo ""
echo "Enter your environment variables (leave blank to skip):"
echo ""

read -p "TELNYX_API_KEY: " TELNYX_API_KEY
if [ -n "$TELNYX_API_KEY" ]; then
    vercel env add TELNYX_API_KEY
    echo $TELNYX_API_KEY | vercel env add TELNYX_API_KEY
fi

read -p "ELEVENLABS_API_KEY: " ELEVENLABS_API_KEY
if [ -n "$ELEVENLABS_API_KEY" ]; then
    vercel env add ELEVENLABS_API_KEY
    echo $ELEVENLABS_API_KEY | vercel env add ELEVENLABS_API_KEY
fi

read -p "ELEVENLABS_VOICE_ID: " ELEVENLABS_VOICE_ID
if [ -n "$ELEVENLABS_VOICE_ID" ]; then
    vercel env add ELEVENLABS_VOICE_ID
    echo $ELEVENLABS_VOICE_ID | vercel env add ELEVENLABS_VOICE_ID
fi

read -p "SUPABASE_SERVICE_ROLE_KEY: " SUPABASE_SERVICE_ROLE_KEY
if [ -n "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    vercel env add SUPABASE_SERVICE_ROLE_KEY
    echo $SUPABASE_SERVICE_ROLE_KEY | vercel env add SUPABASE_SERVICE_ROLE_KEY
fi

# Deploy
echo ""
echo "📤 Deploying to Vercel…"
vercel --prod

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Next steps:"
echo "1. Set Telnyx webhook to: https://your-vercel-url.vercel.app/api/telnyx-voice"
echo "2. Set SMS webhook to:    https://your-vercel-url.vercel.app/api/telnyx-sms"
echo "3. Configure Stripe webhook to: https://your-vercel-url.vercel.app/api/billing/webhook"
