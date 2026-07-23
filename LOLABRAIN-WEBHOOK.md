# LolaBrain Webhook Configuration

## 🔗 Webhook URLs

Both **loladesk** and **lolabrain** use the same webhooks:

| Service | Webhook URL |
|---------|------------|
| **Voice Calls** | `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice` |
| **SMS/WhatsApp** | `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms` |

---

## 📱 Telnyx Configuration for LolaBrain

### **Option 1: Single Voice App (Both Numbers Same Behavior)**

Go to: https://portal.telnyx.com/programmable_voice/applications

1. Create ONE app:
   - Name: `loladesk`
   - **Voice URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice`
   - Method: POST
   - Save

2. Assign both numbers to this app:
   - loladesk number → Voice Settings → Select app `loladesk`
   - **lolabrain number** → Voice Settings → Select app `loladesk`

**Result:** Both numbers answer with same greeting, same behavior

---

### **Option 2: Two Voice Apps (Different Behavior Per Number)**

Go to: https://portal.telnyx.com/programmable_voice/applications

1. Create first app:
   - Name: `loladesk`
   - Voice URL: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice`
   - Assign to: loladesk number

2. Create second app:
   - Name: `lolabrain`
   - Voice URL: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice`
   - Assign to: lolabrain number

**Result:** Both use same endpoint but you can differentiate logic in the code (see below)

---

## 💬 SMS/WhatsApp Webhook

**Same for both numbers:**

Go to: https://portal.telnyx.com/messaging/profiles

1. Create ONE messaging profile:
   - Name: `loladesk-messaging`
   - **Inbound Webhook URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms`
   - Method: POST
   - Save

2. Add both numbers to the profile:
   - Click "Add Phone Number" → loladesk number
   - Click "Add Phone Number" → **lolabrain number**

**Result:** Both numbers handle SMS with same endpoint

---

## 🧠 Differentiate LolaBrain Behavior (Optional)

If you want **lolabrain** to behave differently, edit the code:

📍 File: `api/telnyx-voice.js`

Find this line (around line 150):
```javascript
const toN = e164(payload.to);
```

Add this code right after:
```javascript
const LOLABRAIN_NUMBER = '+1-XXX-XXX-XXXX'; // Replace with your actual lolabrain number

if (toN === LOLABRAIN_NUMBER) {
  // Custom LolaBrain greeting
  if (!speech) {
    reply = `Hi! This is LolaBrain. I'm a specialized analytics assistant. What would you like to know about your business?`;
  }
  // You can add more custom logic here for lolabrain
}
```

Then for SMS, edit `api/telnyx-sms.js` similarly.

After making changes:
```bash
cd LolaDesk
git add -A
git commit -m "Add lolabrain custom behavior"
git push origin main
npx vercel --scope peskoi --project lola-desk --prod --yes
```

---

## 📋 Quick Reference Table

| Component | loladesk | lolabrain | Webhook |
|-----------|----------|-----------|---------|
| Phone # | +1-XXX-XXXX1 | +1-XXX-XXXX2 | Same |
| Voice App | `loladesk` | `loladesk` (same) | `/api/telnyx-voice` |
| Messaging Profile | `loladesk-messaging` | `loladesk-messaging` (same) | `/api/telnyx-sms` |
| Greeting | "Hi, this is Lola…" | "Hi, this is Lola…" (or custom) | Same endpoint |
| Behavior | Booking-focused | Can be customized | Same code path |

---

## ✅ Complete Webhook Setup

### For loladesk number:
```
Voice App: loladesk
  → Webhook: https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice

Messaging Profile: loladesk-messaging
  → Webhook: https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms
```

### For lolabrain number:
```
Voice App: loladesk (same)
  → Webhook: https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice

Messaging Profile: loladesk-messaging (same)
  → Webhook: https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms
```

---

## 🚀 Test Both Numbers

Once configured:

**Call loladesk:**
```
Expected: "Hi, this is Lola at MMΛ Salon..."
```

**Call lolabrain:**
```
Expected: "Hi, this is Lola at MMΛ Salon..." (same, unless customized)
```

**Text loladesk:**
```
"Hi! Do you have extensions?"
Expected: SMS reply within 5 seconds
```

**Text lolabrain:**
```
"What's your availability?"
Expected: SMS reply within 5 seconds
```

---

## 💡 Why Same Webhook?

Both numbers use the same endpoints because:

1. **Tenant Resolution**: The phone number (`to:` in payload) tells Supabase which tenant it is
2. **Routing**: The same code handles both numbers automatically
3. **Efficiency**: One codebase, two numbers, unlimited salons

If you need different behavior per number, you check the `toN` variable in the code.

---

## 📖 See Also

- **CONFIGURATION-CHECKLIST.md** — Full setup steps
- **TWO-NUMBERS-QUICK-START.md** — Quick reference
- **api/telnyx-voice.js** — Voice webhook handler
- **api/telnyx-sms.js** — SMS webhook handler

---

**Summary:** 
- **loladesk webhook**: https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice
- **lolabrain webhook**: https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice (SAME)
- **SMS webhook** (both): https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms
