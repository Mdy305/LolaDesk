# LolaDesk + LolaBrain — Two Phone Numbers Configuration

## Quick Answer: Yes, Assign Both Numbers in Telnyx

**Both numbers need to be assigned in Telnyx to work.** Here's the step-by-step:

---

## ✅ Step 1: Verify You Have Both Numbers

Go to: https://portal.telnyx.com/numbers/phone-numbers

Look for:
- [ ] **loladesk** phone number
- [ ] **lolabrain** phone number

If missing, click **"Buy New Numbers"** and purchase the second.

---

## 🎤 Step 2: Create Voice Application

Go to: https://portal.telnyx.com/programmable_voice/applications

### **Option A: Single App (Both Numbers Same Behavior)**

1. Click **"New Application"**
2. Name: `loladesk`
3. **Voice URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-voice`
4. **Method**: POST
5. Save

Then assign **both numbers** to this app:
- Go to Phone Numbers → loladesk number → Voice Settings → Select app `loladesk`
- Go to Phone Numbers → lolabrain number → Voice Settings → Select app `loladesk`

### **Option B: Two Apps (Different Behavior Per Number)**

Create two applications:
- `loladesk-app` → Voice URL → assign to loladesk number
- `lolabrain-app` → Voice URL → assign to lolabrain number

(Both can point to same endpoint, or different endpoints if you want different logic)

---

## 💬 Step 3: Create Messaging Profile (SMS/WhatsApp)

Go to: https://portal.telnyx.com/messaging/profiles

1. Click **"New Messaging Profile"**
2. Name: `loladesk-messaging`
3. **Inbound Webhook URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms`
4. **Method**: POST
5. Save

---

## 📱 Step 4: Assign Numbers to Messaging Profile

After creating profile:

1. Click the profile → **"Phone Numbers"** tab
2. Click **"Add Phone Number"**
3. Select **loladesk** number → Click **"Add"**
4. Repeat for **lolabrain** number

Now both numbers can:
- ✅ Receive SMS
- ✅ Send SMS replies
- ✅ Handle WhatsApp (if enabled)

---

## 🔗 Configuration Summary

| Component | Config | Status |
|-----------|--------|--------|
| **loladesk voice** | Assigned to voice app | ✅ |
| **lolabrain voice** | Assigned to voice app | ✅ |
| **loladesk SMS** | Added to messaging profile | ✅ |
| **lolabrain SMS** | Added to messaging profile | ✅ |
| **Webhook endpoints** | Both numbers → same endpoints | ✅ |

---

## 🧪 Test Both Numbers

### Test loladesk:
```
Call: +1-XXX-XXX-XXXX (loladesk)
Expected: "Hi, this is Lola at MMΛ Salon..."

Text: "Book me an appointment"
Expected: SMS reply within 5 seconds
```

### Test lolabrain:
```
Call: +1-XXX-XXX-XXXX (lolabrain)
Expected: Same greeting (or custom if you differentiate)

Text: "Hi!"
Expected: SMS reply within 5 seconds
```

---

## 🚀 Done!

Both numbers are now:
- ✅ Accepting calls
- ✅ Connected to Lola's brain
- ✅ Handling SMS/WhatsApp
- ✅ Routing to same Vercel endpoints
- ✅ Speaking in Lola's real voice

For detailed setup, see: **TELNYX-TWO-NUMBERS.md**

---

## 🎯 If You Want Different Behavior Per Number

Want lolabrain to behave differently? Edit `api/telnyx-voice.js`:

```javascript
// At the top of the handler
const LOLABRAIN_NUMBER = '+1-XXX-XXX-XXXX'; // your lolabrain number

// Later in the handler (around line 150)
const toN = e164(payload.to);

if (toN === LOLABRAIN_NUMBER) {
  // Custom logic for lolabrain
  reply = "Hi! I'm LolaBrain - specialized analytics assistant.";
} else {
  // Normal loladesk booking logic
  reply = `Hi, this is Lola at ${tenant.name}...`;
}
```

Then redeploy to Vercel.

---

Questions? See **TELNYX-TWO-NUMBERS.md** for complete guide.
