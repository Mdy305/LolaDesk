# LolaDesk live-voice relay (Railway)

Keeps the dashboard's live conversation with Lola open (browser ⇄ Telnyx AI Assistant).
Vercel can't hold WebSockets, so this small service does.

## Deploy on Railway
1. Railway → your LolaDesk project (or New Project) → New → GitHub Repo → `Mdy305/LolaDesk`.
2. Service → Settings → **Root Directory**: `relay`
3. Service → Variables:
   - `TELNYX_API_KEY` = same as in Vercel
   - `TELNYX_LOLA_BRAIN_ID` = same as in Vercel (assistant-…)
   - `LOLA_VOICE_SECRET` = a long random word — **the same value goes in Vercel**
4. Service → Settings → Networking → **Generate Domain**.
5. Open `https://<that-domain>/health` → must say `"ok":true`.
6. Vercel → Environment Variables:
   - `LOLA_VOICE_RELAY_URL` = `wss://<that-domain>/api/voice-relay`
   - `LOLA_VOICE_SECRET` = the same long word
   Then Redeploy.
