# LolaDesk + LolaBrain — Complete Configuration Checklist

## ✅ Configuration Checklist (Do In This Order)

---

### **1. ENVIRONMENT VARIABLES** (5 min)

📍 Go to: https://vercel.com/peskoi/lola-desk/settings/environment-variables

Add these 7 variables (set scope: **Production + Preview**):

| Variable | Value | Example |
|----------|-------|---------|
| `TELNYX_API_KEY` | Your Telnyx API key | `KEY1234...` |
| `TELNYX_PUBLIC_KEY` | Your Telnyx public key | `PUBLIC...` |
| `ELEVENLABS_API_KEY` | Your ElevenLabs API key | `sk_live...` |
| `ELEVENLABS_VOICE_ID` | Lola's voice ID | `TxGQqXvQvUM...` |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL | `https://xxxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service role | `eyJhbGc...` |
| `APP_URL` | Your Vercel app URL | `https://lola-desk-4k76drro5-peskoi.vercel.app` |

**After adding all:** Click **Redeploy** in Deployments

---

### **2. TELNYX: VOICE CALLS** (5 min)

📍 Go to: https://portal.telnyx.com/programmable_voice/applications

**Create Voice Application:**
- [ ] Click **"New Application"**
- [ ] Name: `loladesk`
- [ ] **Voice URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice`
- [ ] **Fallback URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice`
- [ ] **Method**: POST
- [ ] Click **Save**

---

### **3. TELNYX: ASSIGN LOLADESK NUMBER** (2 min)

📍 Go to: https://portal.telnyx.com/numbers/phone-numbers

**For your loladesk number:**
- [ ] Click the number
- [ ] **Voice Settings** → Select app: `loladesk`
- [ ] Click **Save**

**For your lolabrain number:**
- [ ] Click the number
- [ ] **Voice Settings** → Select app: `loladesk`
- [ ] Click **Save**

✅ Both numbers now route voice calls to your app!

---

### **4. TELNYX: MESSAGING PROFILE** (3 min)

📍 Go to: https://portal.telnyx.com/messaging/profiles

**Create Messaging Profile:**
- [ ] Click **"New Messaging Profile"**
- [ ] Name: `loladesk-messaging`
- [ ] **Inbound Webhook URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms`
- [ ] **Method**: POST
- [ ] Click **Save**

---

### **5. TELNYX: ADD NUMBERS TO PROFILE** (3 min)

**Still in the messaging profile:**
- [ ] Go to **"Phone Numbers"** tab
- [ ] Click **"Add Phone Number"**
- [ ] Select: Your **loladesk** number → Click **Add**
- [ ] Click **"Add Phone Number"** again
- [ ] Select: Your **lolabrain** number → Click **Add**

✅ Both numbers now route SMS/WhatsApp to your app!

---

### **6. TEST VOICE CALLS** (2 min each)

**Test loladesk number:**
- [ ] Call your **loladesk** phone number
- [ ] You should hear: *"Hi, this is Lola at MMΛ Salon. How can I help you today?"*
- [ ] Say: `"Book me a balayage tomorrow at 2pm"`
- [ ] Expected: *"Perfect — I'm booking you for Balayage tomorrow at 2pm."*
- [ ] Hang up

**Test lolabrain number:**
- [ ] Call your **lolabrain** phone number
- [ ] You should hear the same Lola greeting
- [ ] Say: `"What services do you offer?"`
- [ ] Expected: Lola lists services

---

### **7. TEST SMS** (2 min each)

**Test loladesk SMS:**
- [ ] Text your **loladesk** number: `"Hi! Do you have extensions?"`
- [ ] Expected: SMS reply within 5 seconds

**Test lolabrain SMS:**
- [ ] Text your **lolabrain** number: `"What's your availability?"`
- [ ] Expected: SMS reply within 5 seconds

---

### **8. TEST DASHBOARD** (2 min)

- [ ] Go to: https://www.loladesk.com/dashboard
- [ ] Click the **orb** (animated circle)
- [ ] Say: `"Tell me about your services"`
- [ ] Expected: Lola responds in her real voice

---

### **9. (OPTIONAL) CUSTOMIZE LOLABRAIN** (5 min)

If you want lolabrain to behave differently:

📍 Go to: `api/telnyx-voice.js`

Find line ~150 (after `const toN = e164(payload.to);`)

Add this code:

```javascript
const LOLABRAIN_NUMBER = '+1-XXX-XXX-XXXX'; // your lolabrain number

if (toN === LOLABRAIN_NUMBER) {
  // LolaBrain custom logic
  if (!speech) {
    reply = `Hi! This is LolaBrain. I specialize in analytics and reporting. What would you like to know?`;
  }
  // ... add more custom logic here ...
} else {
  // Normal loladesk booking logic (keep existing code)
}
```

Then:
- [ ] Git commit and push
- [ ] Redeploy to Vercel: `npx vercel --scope peskoi --project lola-desk --prod --yes`

---

## 📊 Status Dashboard

| Component | Config | Verify | Status |
|-----------|--------|--------|--------|
| **Vercel App** | Deployed | https://lola-desk-4k76drro5-peskoi.vercel.app | ✅ |
| **Env Variables** | 7 vars set | Vercel Settings | ⏳ |
| **Voice App** | loladesk | Telnyx Applications | ⏳ |
| **loladesk Number** | Assigned to app | Telnyx Phone Numbers | ⏳ |
| **lolabrain Number** | Assigned to app | Telnyx Phone Numbers | ⏳ |
| **SMS Profile** | loladesk-messaging | Telnyx Messaging | ⏳ |
| **Numbers in SMS** | Both added | Messaging Profile → Phone Numbers | ⏳ |
| **Voice Test** | loladesk | Call your loladesk number | ⏳ |
| **Voice Test** | lolabrain | Call your lolabrain number | ⏳ |
| **SMS Test** | loladesk | Text your loladesk number | ⏳ |
| **SMS Test** | lolabrain | Text your lolabrain number | ⏳ |

---

## 🚀 What Happens When Everything is Wired

### **Incoming Call to loladesk:**
```
Caller dials +1-XXX-XXX-XXXX (loladesk)
  ↓
Telnyx receives call
  ↓
Telnyx voice app "loladesk" sends webhook to:
  POST https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice
  ↓
Vercel function receives payload
  ↓
Phone number lookup in Supabase (tenant_config table)
  ↓
AI Brain (Telnyx Inference or Claude) generates reply
  ↓
ElevenLabs synthesizes reply in Lola's voice
  ↓
TeXML response sent back to Telnyx
  ↓
Caller hears: "Hi, this is Lola at MMΛ Salon..."
```

### **Incoming SMS to loladesk:**
```
Caller texts +1-XXX-XXX-XXXX (loladesk)
  ↓
Telnyx receives SMS
  ↓
Telnyx messaging profile sends webhook to:
  POST https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms
  ↓
Vercel function processes message
  ↓
AI generates reply
  ↓
SMS sent back to caller within 5 seconds
```

---

## 🔧 Troubleshooting

### Issue: "Number not assigned" error
**Solution:** 
1. Go to Telnyx Phone Numbers
2. Click your number
3. Voice Settings → Select app "loladesk"
4. Save

### Issue: Call goes through but no greeting
**Solution:**
1. Check ELEVENLABS_API_KEY is set in Vercel
2. Redeploy
3. Check Telnyx webhook URL is correct

### Issue: SMS doesn't come through
**Solution:**
1. Verify number is added to messaging profile
2. Check SMS webhook URL in profile settings
3. Verify webhook URL is accessible: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/health`

### Issue: Lola has generic voice (not ElevenLabs)
**Solution:**
1. Set ELEVENLABS_API_KEY in Vercel env vars
2. Set ELEVENLABS_VOICE_ID (get from elevenlabs.io/app/voices)
3. Redeploy: `npx vercel --scope peskoi --project lola-desk --prod --yes`

---

## 📞 Quick Links

- **Telnyx Portal**: https://portal.telnyx.com
- **Vercel Dashboard**: https://vercel.com/peskoi/lola-desk
- **Your App**: https://lola-desk-4k76drro5-peskoi.vercel.app
- **Dashboard**: https://www.loladesk.com/dashboard

---

## 📖 Documentation

- **TWO-NUMBERS-QUICK-START.md** — This checklist (quick ref)
- **TELNYX-TWO-NUMBERS.md** — Detailed setup guide
- **FIXES-AND-WIRING.md** — Complete architecture
- **WIRING-GUIDE.md** — Technical reference

---

## ✨ You're All Set!

Once you complete all 9 steps above, both your loladesk and lolabrain numbers will be:

✅ Answering calls as Lola in her real voice  
✅ Handling SMS and WhatsApp  
✅ Booking appointments automatically  
✅ Persisting conversations in Supabase  
✅ Running on production Vercel infrastructure

**Go through the checklist, test both numbers, and let me know if anything needs adjustment!**
