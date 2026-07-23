# LolaDesk + LolaBrain — Two Number Setup Guide

You have **two Telnyx numbers**:
- **loladesk** — Main salon front desk (booking, appointments)
- **lolabrain** — Alternative/specialized number (analytics, reporting, backend)

Both need to be configured in Telnyx and wired to Vercel.

---

## 📞 TELNYX: Assign & Configure Numbers

### **Step 1: Verify You Have Two Numbers**

Go to: https://portal.telnyx.com/numbers/phone-numbers

You should see both:
- `+1-XXX-XXX-XXXX` (loladesk)
- `+1-XXX-XXX-XXXX` (lolabrain)

If you only see one, buy the second:
1. Click **"Buy New Numbers"**
2. Select country/area code
3. Choose your number
4. Click **"Buy"**

---

## 🎤 VOICE CALLS Configuration

### **For loladesk number (Main Salon Front Desk)**

1. Go to: https://portal.telnyx.com/programmable_voice/applications
2. Click **"Create Application"** (or select existing)
3. Name it: `loladesk-voice`
4. **Voice URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice`
5. **Method**: POST
6. **Fallback URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice`
7. Click **"Save"**

Now assign your **loladesk phone number** to this app:
1. Go to: https://portal.telnyx.com/numbers/phone-numbers
2. Click your **loladesk number**
3. **Voice Settings** → Select application: `loladesk-voice`
4. Click **"Save"**

### **For lolabrain number (Analytics/Reporting)**

Optional: If lolabrain needs different logic:
1. Create another application: `lolabrain-voice`
2. **Voice URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice` (same endpoint)
   - OR point to a different endpoint if needed
3. Assign your **lolabrain number** to this app

---

## 💬 SMS/WhatsApp Configuration

### **Step 1: Create Messaging Profile**

1. Go to: https://portal.telnyx.com/messaging/profiles
2. Click **"Create Messaging Profile"**
3. Name it: `loladesk-messaging`
4. **Inbound Webhook URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms`
5. **Method**: POST
6. Click **"Create"**

### **Step 2: Assign Your Numbers to Profile**

After creating the profile:

1. Click the profile you just created
2. Go to **"Phone Numbers"** tab
3. Click **"Add Phone Number"**
4. Select your **loladesk number** from dropdown
5. Click **"Add"**

Repeat for **lolabrain number** if you want it to handle SMS too (both can use same messaging profile).

### **Step 3: Enable WhatsApp (Optional)**

1. In the same messaging profile
2. Look for **"WhatsApp Business Account"**
3. Connect your WhatsApp Business Account
4. Your numbers are now live for WhatsApp

---

## 🔗 Quick Reference: Number → Endpoint Mapping

| Number | Service | Endpoint | Status |
|--------|---------|----------|--------|
| loladesk | Voice Calls | `/api/telnyx-voice` | ✅ Voice App assigned |
| loladesk | SMS/WhatsApp | `/api/telnyx-sms` | ✅ Messaging Profile |
| lolabrain | Voice Calls | `/api/telnyx-voice` | ⏳ (Optional) |
| lolabrain | SMS/WhatsApp | `/api/telnyx-sms` | ⏳ (Optional) |

---

## ✨ Test Configuration

### **Test Voice (loladesk number)**
```
1. Call your loladesk number
2. You should hear Lola's greeting
3. Say: "Book me a balayage tomorrow at 2pm"
4. Expected: "Perfect — I'm booking you for Balayage tomorrow at 2pm."
```

### **Test SMS (loladesk number)**
```
1. Text your loladesk number: "Hi! Do you have extensions?"
2. Expected: Reply within 5 seconds
```

### **Test WhatsApp (if enabled)**
```
1. Message your loladesk number on WhatsApp
2. Expected: Same Lola response as SMS
```

---

## 🚨 Common Issues

### **"Number not assigned" error when calling**
- ✅ Solution: Go to phone number → Voice Settings → select application

### **SMS doesn't come through**
- ✅ Solution: Check messaging profile is created + number is added to it

### **Two numbers, same greeting**
- ✅ This is expected. Both route to the same `/api/telnyx-voice` endpoint
- Both numbers resolve to the same tenant in Supabase (`tenant_config` table)
- If you need different behavior per number, add logic in `telnyx-voice.js`

### **How to make numbers behave differently**

If you want **lolabrain** to do something different (e.g., skip booking, just answer questions):

1. In `api/telnyx-voice.js`, add at the top:
```javascript
const LOLABRAIN_NUMBER = '+1-XXX-XXX-XXXX'; // your lolabrain number

// Then in the handler:
if (toN === LOLABRAIN_NUMBER) {
  // Different logic for lolabrain
  reply = `Hi! This is LolaBrain. I can answer questions about your salon.`;
} else {
  // Normal loladesk booking logic
}
```

---

## 📊 Verify Everything is Wired

Run this checklist:

- [ ] Both numbers purchased and active in Telnyx
- [ ] Voice App created + loladesk number assigned
- [ ] Voice URL set: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice`
- [ ] Messaging Profile created + loladesk number added
- [ ] SMS Webhook URL set: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms`
- [ ] Vercel environment variables all set (TELNYX_API_KEY, etc.)
- [ ] Test voice call to loladesk number
- [ ] Test SMS to loladesk number
- [ ] Both get responses from Lola

---

## 🎯 Your Production Setup

```
loladesk phone +1-XXX-XXX-XXXX
    ↓
    ├─ VOICE → Telnyx App "loladesk-voice"
    │           ↓
    │           POST /api/telnyx-voice
    │           ↓
    │           Supabase (tenant_config lookup)
    │           ↓
    │           LLM (Telnyx Inference)
    │           ↓
    │           ElevenLabs (Lola's voice)
    │           ↓
    │           TeXML response → caller hears Lola
    │
    └─ SMS/WhatsApp → Telnyx Messaging Profile
                      ↓
                      POST /api/telnyx-sms
                      ↓
                      Supabase (tenant_config lookup)
                      ↓
                      LLM (Telnyx Inference)
                      ↓
                      SMS reply sent

lolabrain phone +1-XXX-XXX-XXXX
    ↓
    ├─ VOICE → Same or different app (your choice)
    │           ↓
    │           Same endpoints
    │
    └─ SMS → Same messaging profile or separate
```

---

## 📞 Telnyx Support

If you need help:
- **Telnyx Docs**: https://telnyx.com/docs/api/v2/overview
- **Phone Numbers**: https://portal.telnyx.com/numbers/phone-numbers
- **Applications**: https://portal.telnyx.com/programmable_voice/applications
- **Messaging Profiles**: https://portal.telnyx.com/messaging/profiles

---

## ✅ Final: Redeploy After Configuration

Once everything is wired in Telnyx:

```bash
cd LolaDesk

# Make sure all env vars are set in Vercel
# Then redeploy to pick up any changes:

npx vercel --scope peskoi --project lola-desk --prod --yes
```

Then test both numbers!
