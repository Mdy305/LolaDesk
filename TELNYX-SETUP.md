# Telnyx Setup — Voice, Messaging & Numbers

LolaDesk now has the full Telnyx suite. This is what powers the phone, the texting, and the number-selling revenue line.

## The three handlers

| File | What it does |
|------|--------------|
| `api/telnyx-voice.js` | Lola **answers phone calls**. Telnyx hits this URL on every call; it returns TeXML that makes Lola speak, listen, and book. |
| `api/telnyx-sms.js` | Lola **replies to texts**. Inbound SMS → Lola answers → texts back. Also exports `sendSMS()` for outbound (booking links, missed-call text-back). |
| `api/telnyx-numbers.js` | **Search & buy numbers**. Powers the `/numbers` marketplace where salons get their Lola line. Auto-attaches voice + SMS on purchase. |

## Environment variables (Vercel → Settings → Environment Variables)

```
ANTHROPIC_API_KEY          Lola's brain
TELNYX_API_KEY             Voice, SMS, and number provisioning
TELNYX_VOICE_APP_ID        Your TeXML app id (auto-attach voice to new numbers)
TELNYX_MESSAGING_PROFILE   Your messaging profile id (auto-attach SMS)
```

After adding these, **redeploy** so the functions pick them up.

## One-time Telnyx portal setup

**1. Voice (TeXML app)**
- Portal → Voice → Programmable Voice → **Create TeXML App**
- Voice URL: `https://YOUR-APP.vercel.app/api/telnyx-voice` · Method: **POST**
- Copy the app's Connection ID → that's your `TELNYX_VOICE_APP_ID`

**2. Messaging profile**
- Portal → Messaging → **Create messaging profile** (API v2)
- Inbound webhook URL: `https://YOUR-APP.vercel.app/api/telnyx-sms`
- Copy the profile ID → that's your `TELNYX_MESSAGING_PROFILE`

**3. API key**
- Portal → Auth → **Create API Key** → that's your `TELNYX_API_KEY`

## How a salon gets a working number

1. Salon opens `/numbers` in the dashboard
2. Searches by area code → sees available local numbers
3. Clicks **Get this number**
4. `telnyx-numbers.js` orders it AND attaches your TeXML voice app + messaging profile
5. Lola is instantly live on that number — answers calls and texts immediately

## The revenue model (this is the money part)

| Line | Telnyx cost | You charge | Margin |
|------|-------------|------------|--------|
| Phone number rent | ~$1/mo | $5/mo | recurring |
| Inbound voice | ~$0.012/min | bundled in plan | overage above bundle |
| Outbound voice (rebooking calls) | ~$0.012/min | bundled | drives salon revenue |
| SMS | ~$0.004/msg | bundled | overage above bundle |

Every salon needs a number → that's recurring rent from day one. Usage rides on top. The `RETAIL_MONTHLY` constant in `numbers.html` sets the number price; the proxy meter in `lola-proxy-worker.js` tracks AI usage per tenant for plan limits.

## Testing voice locally

You can't fully test inbound voice without a real Telnyx number pointed at a public URL. Once deployed:
1. Buy a number (via `/numbers` or the portal)
2. Point its TeXML app at `/api/telnyx-voice`
3. Call the number → Lola answers

## Production notes

- `resolveTenant()` in each handler currently returns a demo salon. Wire it to look up the salon by the **called number** (`To`) in your database so each number routes to the right salon's Lola.
- In-call and in-text memory is in-process (resets on cold start). For production, move it to Redis or your DB keyed by caller number.
- Add STOP/HELP keyword handling in `telnyx-sms.js` for 10DLC compliance before high-volume texting.
