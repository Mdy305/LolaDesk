# Telnyx Messaging Setup: API v1 vs v2

## 🎯 Quick Answer

**Use Telnyx Messaging API v2** (recommended for new setups)

---

## 📊 Comparison: v1 vs v2

| Feature | API v1 | API v2 |
|---------|--------|--------|
| **Webhook Format** | Legacy XML/form-encoded | Modern JSON |
| **Supported** | Deprecated (old projects) | ✅ Current standard |
| **WhatsApp** | Limited | ✅ Full support |
| **Webhook URL** | `/messaging/callback` | `/messaging/webhooks` |
| **Authentication** | Basic webhook | Signature verification |
| **LolaDesk Support** | Partial | ✅ Full support |

---

## ✅ Use API v2 (Recommended)

### **Telnyx Dashboard Setup**

Go to: https://portal.telnyx.com/messaging/profiles

1. Click **"Create New Messaging Profile"**
2. Name: `loladesk-messaging`
3. **Inbound Webhook URL**: 
   ```
   https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms
   ```
4. **Method**: POST
5. **API Version**: v2 (should be default)
6. Click **"Create"**

Then add your numbers:
- Go to "Phone Numbers" tab
- Add loladesk number
- Add lolabrain number

---

## 🔧 Code Support (Already Included)

Your `api/telnyx-sms.js` already supports **API v2**.

The payload format it expects:
```javascript
{
  "data": {
    "payload": {
      "from": "+1-555-1234",
      "to": [{ "phone_number": "+1-XXX-XXXX" }],
      "text": "Hi! Do you have extensions?",
      "media": [...],
      "event_type": "message.received"
    }
  }
}
```

✅ This matches **Telnyx API v2** format

---

## ❌ Don't Use API v1 (Legacy)

API v1 is deprecated. Only use if:
- You have an existing old project
- Telnyx requires it for legacy integration

For **new deployments**, always use **v2**.

---

## 🧪 Test Your Setup

After configuration:

**Text your loladesk number:**
```
"Hi! Do you have extensions?"
```

Expected response within 5 seconds:
```
"We offer luxury hair extensions from $800..."
```

---

## 📞 Webhook Details (v2)

**Endpoint**: `/api/telnyx-sms`

**Request Body** (JSON):
```json
{
  "data": {
    "event_type": "message.received",
    "payload": {
      "from": "+1-555-1234",
      "to": [{ "phone_number": "+1-786-449-7058" }],
      "text": "Book me an appointment",
      "media": [],
      "timestamp": "2024-07-23T12:00:00.000Z"
    }
  }
}
```

**Response**: JSON (status + message)
```json
{ "status": "success" }
```

---

## ✅ Configure v2 in Telnyx NOW

1. Go to: https://portal.telnyx.com/messaging/profiles
2. Create profile `loladesk-messaging`
3. **Webhook URL**: `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms`
4. Ensure **API v2** is selected (default)
5. Add both numbers to profile
6. Save

---

## 📖 See Also

- **CONFIGURATION-CHECKLIST.md** — Complete setup steps
- **TELNYX-TWO-NUMBERS.md** — Full Telnyx guide
- **api/telnyx-sms.js** — Webhook handler code

---

## 🎯 Summary

| Item | Answer |
|------|--------|
| Which API? | **v2 (Telnyx Messaging API v2)** |
| Webhook URL? | `https://lola-desk-4k76drro5-peskoi.vercel.app/api/telnyx-sms` |
| Format? | JSON |
| Both numbers? | Yes, add both to same profile |
| WhatsApp? | Yes, supported with v2 |
| Status? | ✅ Ready to configure |

**Action:** Go to Telnyx dashboard → Create profile with v2 → Add webhook URL → Test both numbers
