# Vercel Environment Variables — Complete List

## 🎯 Required Variables for LolaDesk

Go to: https://vercel.com/peskoi/lola-desk/settings/environment-variables

Add these **7 REQUIRED variables**:

---

## 📋 All Environment Variables

### **1. TELNYX_API_KEY** (Required)
- **Where to get**: https://portal.telnyx.com/auth → API Keys
- **What it is**: Your Telnyx API key for voice/SMS
- **Example**: `KEY12345abc...`
- **Scope**: Production, Preview, Development
- **Action**: Paste your key → Save

---

### **2. TELNYX_PUBLIC_KEY** (Required)
- **Where to get**: https://portal.telnyx.com/auth → Public Keys
- **What it is**: Public key for signature verification
- **Example**: `PUBLIC12345...`
- **Scope**: Production, Preview, Development
- **Action**: Paste your key → Save

---

### **3. ELEVENLABS_API_KEY** (Required)
- **Where to get**: https://elevenlabs.io/profile → API Keys
- **What it is**: Your ElevenLabs API key for voice synthesis
- **Example**: `sk_live_abc123...`
- **Scope**: Production, Preview, Development
- **Action**: Paste your key → Save

---

### **4. ELEVENLABS_VOICE_ID** (Required)
- **Where to get**: https://elevenlabs.io/app/voices → click your voice
- **What it is**: Lola's voice ID (unique per voice)
- **Example**: `TxGQqXvQvUMEUxtXKvou` (40-char hex)
- **Scope**: Production, Preview, Development
- **Action**: Copy voice ID → Save

---

### **5. NEXT_PUBLIC_SUPABASE_URL** (Required)
- **Where to get**: https://supabase.com → Project Settings → API → Project URL
- **What it is**: Your Supabase project URL (public)
- **Example**: `https://xxxxx.supabase.co`
- **Scope**: Production, Preview, Development
- **Action**: Paste URL → Save

---

### **6. SUPABASE_SERVICE_ROLE_KEY** (Required - SECRET!)
- **Where to get**: https://supabase.com → Project Settings → API → Service Role Secret
- **What it is**: Supabase service role key (KEEP SECRET!)
- **Example**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`
- **Scope**: Production, Preview, Development
- **Action**: Paste key → Save
- ⚠️ **WARNING**: Never share this key, never commit to code

---

### **7. APP_URL** (Required)
- **Where to get**: Your Vercel deployment URL
- **What it is**: Base URL for webhook callbacks
- **Example**: `https://lola-desk-4k76drro5-peskoi.vercel.app`
- **Scope**: Production
- **Action**: Paste your Vercel URL → Save

---

## 📊 Optional Variables

These are optional but recommended:

### **INTEGRATION_ENCRYPTION_KEY** (Optional but recommended)
- **What it is**: Key for encrypting OAuth tokens at rest
- **Generate**: Run in terminal:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- **Example**: `a1b2c3d4e5f6...` (64-char hex)
- **Scope**: Production, Preview, Development

---

### **STRIPE_API_KEY** (Optional - for payments)
- **Where to get**: https://dashboard.stripe.com → Developers → API Keys → Secret Key
- **What it is**: Stripe secret key for billing
- **Example**: `sk_test_51234...`
- **Scope**: Production, Preview, Development

---

### **STRIPE_WEBHOOK_SECRET** (Optional - for payments)
- **Where to get**: Stripe webhook endpoint settings
- **What it is**: Webhook signing secret
- **Example**: `whsec_test_1234...`
- **Scope**: Production, Preview, Development

---

### **SQUARE_CLIENT_ID** (Optional - for Square integration)
- **Where to get**: https://squareup.com/dashboard → Developers → Applications
- **What it is**: Square app client ID
- **Example**: `sq_app_1234...`
- **Scope**: Production, Preview, Development

---

### **SQUARE_CLIENT_SECRET** (Optional - for Square integration)
- **Where to get**: Square application settings
- **What it is**: Square app secret
- **Example**: `sq_secret_1234...`
- **Scope**: Production, Preview, Development

---

### **AWS_SES_ACCESS_KEY** (Optional - for email)
- **Where to get**: AWS IAM console
- **What it is**: AWS access key for SES
- **Example**: `AKIAIOSFODNN7EXAMPLE`
- **Scope**: Production, Preview, Development

---

### **AWS_SES_SECRET_KEY** (Optional - for email)
- **Where to get**: AWS IAM console
- **What it is**: AWS secret key for SES
- **Example**: `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`
- **Scope**: Production, Preview, Development

---

### **AWS_SES_REGION** (Optional - for email)
- **What it is**: AWS region for SES
- **Example**: `us-east-1`
- **Default**: `us-east-1`
- **Scope**: Production, Preview, Development

---

### **NODE_ENV** (Optional)
- **What it is**: Environment mode
- **Options**: `development`, `production`
- **Example**: `production`
- **Scope**: Production

---

## ✅ Step-by-Step: Add Variables to Vercel

### **Step 1: Open Vercel Settings**
Go to: https://vercel.com/peskoi/lola-desk/settings/environment-variables

### **Step 2: Add Each Variable**
For each of the 7 required variables:

1. Click **"Add New"**
2. **Name**: (e.g., `TELNYX_API_KEY`)
3. **Value**: (paste your value)
4. **Environment**: Check all three:
   - [ ] Production
   - [ ] Preview
   - [ ] Development
5. Click **"Save"**

### **Step 3: Redeploy After Adding**
After adding all variables:
1. Go to **Deployments** (left sidebar)
2. Click the latest deployment
3. Click **"Redeploy"** (top right button)
4. Wait for build to complete (1-2 min)

✅ **Now your app has all the keys!**

---

## 🔐 Security Notes

| Variable | Secret? | Where to Store |
|----------|---------|-----------------|
| TELNYX_API_KEY | ✅ Yes | Vercel env only |
| ELEVENLABS_API_KEY | ✅ Yes | Vercel env only |
| SUPABASE_SERVICE_ROLE_KEY | ✅ Yes | Vercel env only |
| INTEGRATION_ENCRYPTION_KEY | ✅ Yes | Vercel env only |
| STRIPE_API_KEY | ✅ Yes | Vercel env only |
| APP_URL | ❌ No | Can be public |
| ELEVENLABS_VOICE_ID | ❌ No | Can be public |
| NEXT_PUBLIC_SUPABASE_URL | ❌ No | Can be public |

**Rule: Never commit `.env` files to GitHub. Vercel env vars are encrypted.**

---

## 📋 Checklist: Environment Variables

Go through each item:

### **Required (Must Have):**
- [ ] TELNYX_API_KEY — added and saved
- [ ] TELNYX_PUBLIC_KEY — added and saved
- [ ] ELEVENLABS_API_KEY — added and saved
- [ ] ELEVENLABS_VOICE_ID — added and saved
- [ ] NEXT_PUBLIC_SUPABASE_URL — added and saved
- [ ] SUPABASE_SERVICE_ROLE_KEY — added and saved
- [ ] APP_URL — added and saved

### **Recommended (Nice to Have):**
- [ ] INTEGRATION_ENCRYPTION_KEY — added and saved

### **Optional (If Using):**
- [ ] STRIPE_API_KEY — (if using payments)
- [ ] STRIPE_WEBHOOK_SECRET — (if using payments)
- [ ] SQUARE_CLIENT_ID — (if using Square)
- [ ] AWS_SES_ACCESS_KEY — (if using email)

### **After Adding All:**
- [ ] Clicked **"Redeploy"** button
- [ ] Waited for build to complete (green checkmark)
- [ ] App is now live with all keys

---

## 🧪 Verify Variables Are Set

After redeploying, your app should:
- ✅ Accept voice calls (Telnyx)
- ✅ Respond with Lola's voice (ElevenLabs)
- ✅ Store data in Supabase
- ✅ Accept SMS messages

---

## 🚨 Troubleshooting

### "Lola has generic voice, not ElevenLabs"
**Solution:**
- [ ] Verify ELEVENLABS_API_KEY is set
- [ ] Verify ELEVENLABS_VOICE_ID is set (not empty)
- [ ] Redeploy after adding/fixing

### "Can't connect to database"
**Solution:**
- [ ] Verify NEXT_PUBLIC_SUPABASE_URL is set
- [ ] Verify SUPABASE_SERVICE_ROLE_KEY is set
- [ ] Redeploy

### "Calls don't connect"
**Solution:**
- [ ] Verify TELNYX_API_KEY is set
- [ ] Verify TELNYX_PUBLIC_KEY is set
- [ ] Verify APP_URL is set to your Vercel URL
- [ ] Redeploy

---

## 📖 Where to Get Each Key

| Key | Portal | Path |
|-----|--------|------|
| TELNYX_API_KEY | portal.telnyx.com | Auth → API Keys |
| ELEVENLABS_API_KEY | elevenlabs.io | Profile → API Keys |
| ELEVENLABS_VOICE_ID | elevenlabs.io | Voices → click your voice |
| SUPABASE_URL | supabase.com | Project → Settings → API |
| SUPABASE_KEY | supabase.com | Project → Settings → API → Service Role |

---

## 🎯 Next Steps

1. **Get your API keys** from each service
2. **Go to Vercel settings** → Environment Variables
3. **Add all 7 required variables**
4. **Click Redeploy**
5. **Wait for build** (green checkmark)
6. **Test both numbers** (call + SMS)

You're all set! 🚀

---

## 📞 Quick Reference Card

```
╔════════════════════════════════════════════════════════════╗
║          Vercel Environment Variables (Required)           ║
╠════════════════════════════════════════════════════════════╣
║ TELNYX_API_KEY               → portal.telnyx.com          ║
║ TELNYX_PUBLIC_KEY            → portal.telnyx.com          ║
║ ELEVENLABS_API_KEY           → elevenlabs.io              ║
║ ELEVENLABS_VOICE_ID          → elevenlabs.io/app/voices   ║
║ NEXT_PUBLIC_SUPABASE_URL     → supabase.com               ║
║ SUPABASE_SERVICE_ROLE_KEY    → supabase.com (SECRET!)    ║
║ APP_URL                      → your Vercel URL            ║
╠════════════════════════════════════════════════════════════╣
║ After adding: Click Redeploy, wait 1-2 min for green ✓   ║
╚════════════════════════════════════════════════════════════╝
```

Save this for reference!
