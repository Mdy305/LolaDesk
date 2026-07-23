# LolaDesk: AI Voice Assistant Front Desk — Integration & Wiring Guide

## 🎯 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    BROWSER (dashboard.html)                      │
│  • Dashboard UI with neural orb + voice commands                 │
│  • Ambient wake-word listening ("Hey Lola…")                     │
│  • Tap-to-talk for quick commands                                │
└────────────┬────────────────────────────────────────────────────┘
             │ /api/lola (chat proxy)
┌────────────▼────────────────────────────────────────────────────┐
│              VERCEL SERVERLESS FUNCTIONS (api/)                  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  /api/lola.js — Dashboard chat orchestrator              │  │
│  │  • Detects booking intents (fast-path)                   │  │
│  │  • Routes to skill layer or LLM                          │  │
│  │  • Persistent memory via Supabase                        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  /api/telnyx-voice.js — Real phone calls                 │  │
│  │  • Receives TeXML POST from Telnyx                       │  │
│  │  • Tenant resolution by called number                    │  │
│  │  • Speech → LLM → ElevenLabs voice → TeXML              │  │
│  │  • Missed-call text-back, smart re-prompts              │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  /api/telnyx-sms.js — Text & WhatsApp                   │  │
│  │  • SMS inbound + STOP/HELP keyword compliance           │  │
│  │  • WhatsApp routing                                      │  │
│  │  • Hair analysis image detection                         │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  /api/lib/llm.js — AI Brain Router                       │  │
│  │  • Primary: Telnyx Inference (moonshotai/Kimi-K2.6)     │  │
│  │  • Fallback: Anthropic Claude                           │  │
│  │  • Tool calling, resilient retries                      │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  /api/lib/elevenlabs.js — Voice Synthesis              │  │
│  │  • Same voice on calls AND dashboard                    │  │
│  │  • ElevenLabs voice ID = Lola's identity               │  │
│  │  • Cached synthesis (replay deterministic answers)     │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  /api/lola-tools.js — Skill Layer                       │  │
│  │  • book_appointment, check_availability, etc.           │  │
│  │  • Deterministic (no LLM) fast-path answers             │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
       │                            │                     │
       ▼                            ▼                     ▼
┌────────────────┐      ┌──────────────────┐    ┌──────────────────┐
│    TELNYX      │      │    SUPABASE      │    │   ELEVENLABS     │
│  • Voice calls │      │  • Auth + users  │    │  • Lola's voice  │
│  • SMS/WhatsApp│      │  • Tenant config │    │  • Real voice ID │
│  • Numbers API │      │  • Conversations │    │  • Studio tuning │
└────────────────┘      │  • Client memory │    └──────────────────┘
                        │  • Interactions  │
                        │  • Integrations  │
                        └──────────────────┘
```

---

## 🔧 Core Integration Points

### 1. **Tenant Resolution by Phone Number**
- When a call lands on `/api/telnyx-voice`, the **called number** (e.g., +1-786-449-7058) is the key.
- Telnyx payload → extract `to` phone → query Supabase `tenant_config` table for `assigned_phone_number`.
- **Result**: Every salon is isolated; no code changes needed to add a new one.

### 2. **AI Brain Selection** (`/api/lib/llm.js`)
- Default: **Telnyx Inference** (moonshotai/Kimi-K2.6) — lowest latency for phone calls.
- Fallback: **Anthropic Claude** (if `LLM_PROVIDER=anthropic`).
- **Never expose API keys to the browser**; all inference happens server-side via `/api/lola` proxy.

### 3. **Voice Synthesis** (`/api/lib/elevenlabs.js`)
- **One Lola voice everywhere**: same `ELEVENLABS_VOICE_ID` on phone calls, dashboard chat, and SMS.
- Synthesis cached by text hash → first caller pays ElevenLabs cost, subsequent callers instant replay.
- Keyed audio stored at `/api/voice-audio?id=<hash>` for TeXML `<Play>` consumption.

### 4. **Dashboard Chat with Memory** (`/api/lola.js`)
- Browser sends message to `/api/lola` (never LLM keys exposed).
- Server recalls last 12 turns from `conversations` table (channel: 'dashboard').
- Skill layer attempts deterministic replies first (booking fast-path).
- Falls back to LLM if no deterministic match.
- **Result**: Lola remembers context across browser sessions.

### 5. **Phone Call Real-Time Loop**
```
1. Telnyx calls /api/telnyx-voice with speech input
2. Extract tenant by called number
3. Deterministic skill check (book_appointment, check_availability, etc.)
4. If no skill match → LLM call (speech → LLM → reply)
5. Synthesize reply to audio (ElevenLabs or cache hit)
6. Return TeXML with <Play> (audio) + <Gather> (next speech input)
7. Caller hears Lola's real voice, responds
8. Loop back to step 1
```

---

## 🚀 Quick Start: Docker Local Development

```bash
# 1. Clone the repo
git clone https://github.com/Mdy305/LolaDesk.git
cd LolaDesk

# 2. Copy env file and fill in your API keys
cp .env.example .env.local

# Edit .env.local:
#   TELNYX_API_KEY=your_key_here
#   ELEVENLABS_API_KEY=your_key_here
#   ELEVENLABS_VOICE_ID=your_voice_id_here
#   SUPABASE_SERVICE_ROLE_KEY=your_key_here

# 3. Start Docker (includes Postgres, app, adminer)
docker-compose up

# 4. Open browser
# Dashboard: http://localhost:3000/dashboard.html
# Adminer (DB UI): http://localhost:8081

# 5. Test Lola
# In dashboard, click the orb and say "Book me a balayage tomorrow at 2 PM"
```

---

## 🔌 Telnyx Webhook Configuration

After deploying to Vercel (or exposing localhost via ngrok):

### **Voice Calls**
1. Go to **Telnyx Console** → **Programmable Voice** → **Applications**
2. Create or select your application
3. **Voice URL**: `https://your-app.vercel.app/api/telnyx-voice`
4. **Method**: POST
5. Save

### **SMS / WhatsApp**
1. Go to **Telnyx Console** → **Messaging** → **Messaging Profiles**
2. Select your profile
3. **Inbound Webhook URL**: `https://your-app.vercel.app/api/telnyx-sms`
4. **Method**: POST
5. Save

---

## 🎤 ElevenLabs Voice Setup

1. **Create ElevenLabs account**: https://elevenlabs.io
2. **Create or clone a voice**:
   - Go to **Voices** → **Create a new voice** or select **Lola** (if already created)
   - Customize tone, accent, emotion (important for brand consistency)
3. **Get your voice ID**:
   - Click the voice in the list
   - Copy the voice ID (40-char hex, e.g., `TxGQqXvQvUMEUxtXKvou`)
4. **Set in env**:
   ```bash
   ELEVENLABS_API_KEY=sk_live_xxxxx
   ELEVENLABS_VOICE_ID=TxGQqXvQvUMEUxtXKvou
   ```

---

## 📊 Supabase Setup

1. **Create Supabase project**: https://supabase.com
2. **Run schema**:
   ```bash
   psql -h your-supabase-host -U postgres -d postgres < schema.sql
   ```
   Or via Supabase dashboard SQL editor: paste contents of `ALL-IN-ONE-database-setup.sql`
3. **Get credentials**:
   - Project Settings → API → Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - Project Settings → API → Service Role Secret → `SUPABASE_SERVICE_ROLE_KEY`
4. **Set in env**:
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...xxxxx
   ```

---

## 🧠 How Lola's Brain Works

### **Skill Layer** (Fast Path — No LLM)
User: "Book me a balayage tomorrow at 2pm"
→ Regex extraction: service="Balayage", date="tomorrow", time="2pm"
→ Direct call to `book_appointment()` in lola-tools.js
→ Result: Instant confirmation (under 100ms), no LLM needed

### **LLM Path** (Contextual Answers)
User: "Tell me about our extensions service"
→ No exact skill match
→ Query LLM with system prompt (includes tenant's services, hours, location)
→ LLM synthesizes conversational reply
→ Cache the audio if it's deterministic

### **Memory**
- **Dashboard**: Lola recalls last 12 messages in browser tab (survives refresh)
- **Calls**: Each call builds a transcript, searchable by client phone number
- **SMS**: Conversations stored per client, per tenant
- **Emergent**: Client memories accumulate over turns (name, preferences, history)

---

## 🚨 Debugging Checklist

### **Voice call lands but Lola doesn't answer**
```bash
docker-compose logs app | grep "telnyx-voice"
# Check: tenant found? → LLM response? → ElevenLabs synthesis?
```

### **Dashboard chat says "trouble reaching brain"**
```bash
# Check TELNYX_API_KEY in .env.local
# Check /api/lib/llm.js receives chat() calls
# Check Telnyx inference quota
```

### **Lola has generic voice instead of custom ElevenLabs voice**
```bash
# Check ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in env
# Check /api/lib/elevenlabs.js isConfigured()
# Verify voice ID is correct: elevenlabs.io/app/voices
```

### **SMS text-back doesn't send**
```bash
# Check TELNYX_API_KEY for SMS permissions
# Check opt-out table: SELECT * FROM sms_optouts
# Check /api/telnyx-sms.js sendSMS() logs
```

---

## 📦 Docker Compose Services

| Service | Port | Purpose |
|---------|------|---------|
| `app` | 3000 | Vercel dev server (API + static HTML) |
| `app` | 8080 | Python HTTP server (static assets fallback) |
| `supabase` | 5432 | Postgres database |
| `adminer` | 8081 | Web UI for database admin |

---

## 🔐 Environment Variables Checklist

**Required for voice:**
- `TELNYX_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_URL` (for texml `<Play>` URLs)

**Optional:**
- `STRIPE_API_KEY` (billing)
- `SQUARE_CLIENT_ID / SECRET` (Square integration)
- `ANTHROPIC_API_KEY` (Claude fallback)
- `AWS_SES_*` (email)

---

## 🧪 Test Flows

### **1. Dashboard Chat → Lola Responds**
1. Open http://localhost:3000/dashboard.html
2. Click the orb
3. Say: "What services do we offer?"
4. Expected: Lola lists services in her real voice

### **2. Booking Fast-Path**
1. Say: "Book me a balayage tomorrow at 3pm"
2. Expected: Confirmation under 1 second (skill layer, no LLM)

### **3. SMS Inbound**
1. Text the salon's Telnyx number: "Hi, do you have availability tomorrow?"
2. Expected: Lola's SMS reply within 5 seconds

### **4. Missed Call Text-Back**
1. Call the salon's Telnyx number
2. Stay silent or hang up after first prompt
3. Expected: SMS arrives within 2 seconds ("I can book you by text")

---

## 🚢 Deploying to Vercel

```bash
# 1. Ensure code is on GitHub
git add . && git commit -m "LolaDesk ready for deployment"
git push origin main

# 2. Deploy to Vercel
vercel --prod

# 3. Add environment variables in Vercel dashboard
# Settings → Environment Variables → add all from .env.local

# 4. Redeploy (Vercel doesn't hot-reload env vars)
# Deployments → [latest] → ⋯ → Redeploy

# 5. Update Telnyx webhooks
# Voice URL: https://your-vercel-url.vercel.app/api/telnyx-voice
# SMS URL: https://your-vercel-url.vercel.app/api/telnyx-sms

# 6. Test live
# Call your Telnyx number, or text it, or use dashboard
```

---

## 📞 Support

- **Telnyx**: https://telnyx.com/docs/api/v2/overview
- **ElevenLabs**: https://docs.elevenlabs.io/
- **Supabase**: https://supabase.com/docs
- **LolaDesk README**: See README.md in repo root
