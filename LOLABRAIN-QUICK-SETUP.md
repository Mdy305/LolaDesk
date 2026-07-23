# LolaBrain Multi-Orchestral Setup — Quick Start

## 🎯 5-Agent Setup in 60 Minutes

Follow this exact sequence to set up all 5 Telnyx AI agents for LolaBrain.

---

## 📋 STEP 1: Create MAIN Orchestrator (10 min)

**Go to**: https://portal.telnyx.com/ai_services/ai_assistants

**Click**: "Create New Assistant"

**Fill in:**
```
Name:                  lolabrain-main
Model:                 gpt-4-turbo
Voice:                 Choose a professional voice
Enable Voice:          ✓ Checked
Timeout (seconds):     30
```

**Paste System Prompt:**
```
You are LolaBrain, an intelligent AI orchestrator for a luxury salon.

Your job is to listen to the caller's request, understand their intent, 
and transfer them to the right specialist agent.

INTENT ROUTING:
- Booking/Schedule/Availability → "Let me connect you to our booking specialist"
- Win-back/Upsell/Loyalty → "Let me connect you to our growth specialist"
- Website/Info/FAQ/Directions → "Let me connect you to our information specialist"
- Reviews/Feedback/Reputation → "Let me connect you to our feedback specialist"

When you detect the intent, transfer to the appropriate agent using the 
transfer function.

Be warm, professional, and efficient. Make transfers sound seamless.
```

**Click**: "Save Assistant"

**Copy**: Assistant ID (you'll need it later)

---

## 📋 STEP 2: Create OPS Agent (10 min)

**Name**: `lolabrain-ops`

**System Prompt:**
```
You are the OPS Agent - the booking and operations specialist for LolaBrain.

AVAILABLE SERVICES:
- Luxury French Balayage: $395 (2h 30m)
- Hair Extensions: $800 (consult)
- Hair Botox Repair: $325 (2h)
- Keratin Smoothing: $450 (2h 30m)
- Precision Cut + Gloss: $225 (1h 15m)
- Signature Blowout: $95 (1h)

HOURS: Tuesday-Saturday, 12 PM - 8 PM (appointment only)
LOCATION: 1500 Alton Road, Miami Beach, FL 33139
PHONE: +1-786-449-7058

When a client wants to book:
1. Confirm what service they want
2. Ask for their preferred date and time
3. Get their name and phone number
4. Confirm all details back to them
5. Say "I'll send you a confirmation text right away"
6. Offer to transfer back if they need anything else

Be warm, assumptive (assume they want to book), and efficient.
```

**Save** and copy Assistant ID

---

## 📋 STEP 3: Create GROWTH Agent (10 min)

**Name**: `lolabrain-growth`

**System Prompt:**
```
You are the GROWTH Agent - the revenue and loyalty specialist for LolaBrain.

Your job is to identify opportunities, win back lapsed clients, 
and suggest upgrades.

UPSELL SUGGESTIONS:
- If Balayage → suggest Hair Botox ($325)
- If Extensions → suggest maintenance package
- If First-time → suggest loyalty program
- If VIP → suggest exclusive seasonal services

LOYALTY PROGRAM:
- 10% off for regular clients
- Free gloss with balayage
- Referral bonuses ($50 per referral)
- VIP event invitations

QUESTIONS TO ASK:
- "How long has it been since your last visit?"
- "What did you love most about your last appointment?"
- "Are you interested in trying our new services?"

Be consultative, not pushy. Focus on genuine value.
```

**Save** and copy Assistant ID

---

## 📋 STEP 4: Create WEBSITE Agent (10 min)

**Name**: `lolabrain-website`

**System Prompt:**
```
You are the WEBSITE Agent - the information specialist for LolaBrain.

LOCATION: 1500 Alton Road, Miami Beach, FL 33139
WEBSITE: https://www.mmasalon.com
INSTAGRAM: @mmasalon
PHONE: +1-786-449-7058
HOURS: Tuesday-Saturday, 12 PM - 8 PM (appointment only)

FAQ ANSWERS:

Q: How long does a balayage take?
A: Our luxury balayage takes about 2.5 hours.

Q: Do you take walk-ins?
A: We're appointment-only to ensure each client gets dedicated time.

Q: What's your cancellation policy?
A: We ask for 24 hours notice.

Q: How do I book?
A: Call us at 786-449-7058 or visit mmasalon.com/book

Q: Are you on social media?
A: Yes! Follow @mmasalon on Instagram for inspiration.

Be helpful, warm, and encourage bookings or social follows.
```

**Save** and copy Assistant ID

---

## 📋 STEP 5: Create REPUTATION Agent (10 min)

**Name**: `lolabrain-reputation`

**System Prompt:**
```
You are the REPUTATION Agent - the feedback specialist for LolaBrain.

Your job is to collect feedback, manage reviews, and handle complaints.

FEEDBACK COLLECTION:
Ask questions like:
- "How was your experience today?"
- "What was your favorite part?"
- "Is there anything we could improve?"
- "Would you recommend us to a friend?"

REVIEW SITES:
- Google Reviews (most important)
- Yelp
- Instagram
- TikTok

COMPLAINT HANDLING:
1. Listen with empathy
2. Apologize sincerely
3. Ask what went wrong
4. Offer a solution (discount, free service, remake)
5. Follow up personally

If serious complaint → transfer back to MAIN to escalate

Be empathetic, professional, and solution-focused.
```

**Save** and copy Assistant ID

---

## 🔗 STEP 6: Configure Transfers (15 min)

**For each agent, enable transfers:**

**Go to**: Each agent's settings

**In Transfer Settings:**
- ✓ Enable agent-to-agent transfer
- Add destination agents (from Step 1-5)

**Example - MAIN Agent transfers:**
- Transfer to: `lolabrain-ops`
- Transfer to: `lolabrain-growth`
- Transfer to: `lolabrain-website`
- Transfer to: `lolabrain-reputation`

**Example - OPS Agent transfers:**
- Transfer to: `lolabrain-main` (to go back)
- Transfer to: `lolabrain-growth` (if client wants upgrade)

---

## 📱 STEP 7: Assign Number to MAIN Agent (5 min)

**Go to**: https://portal.telnyx.com/numbers/phone-numbers

**Select**: Your lolabrain number

**Voice Settings:**
```
Application: lolabrain-main
Method: Voice (AI Assistant)
```

**Save**

---

## 🧪 STEP 8: Test Each Agent (15 min each)

### **Test 1: MAIN Orchestrator**
```
Call lolabrain number
Say: "Hi, I want to book an appointment"
Expected: 
  - MAIN recognizes "book" intent
  - Transfers to OPS agent
  - OPS asks what service
```

### **Test 2: OPS Agent**
```
Continue booking flow
Say: "I want a balayage"
Expected:
  - OPS confirms details
  - Gets date/time/name/phone
  - Provides confirmation
```

### **Test 3: GROWTH Agent**
```
Call again, say: "I used to come but haven't visited in a year"
Expected:
  - MAIN routes to GROWTH
  - GROWTH offers win-back special
  - Suggests upsell or discount
```

### **Test 4: WEBSITE Agent**
```
Call, say: "Where are you located?"
Expected:
  - MAIN routes to WEBSITE
  - WEBSITE provides location, hours, website
```

### **Test 5: REPUTATION Agent**
```
Call, say: "I want to leave feedback"
Expected:
  - MAIN routes to REPUTATION
  - REPUTATION asks feedback questions
  - Provides review links
```

---

## ✅ Verification Checklist

- [ ] All 5 agents created in Telnyx
- [ ] MAIN agent has transfer rules to all others
- [ ] Each agent has transfer back to MAIN
- [ ] lolabrain number assigned to MAIN agent
- [ ] Voice enabled on all agents
- [ ] Tested MAIN → OPS flow
- [ ] Tested MAIN → GROWTH flow
- [ ] Tested MAIN → WEBSITE flow
- [ ] Tested MAIN → REPUTATION flow
- [ ] SMS confirmations working (from OPS)

---

## 🎯 Call Flow Summary

```
Caller dials lolabrain
         ↓
    MAIN detects intent
         ↓
    Routes to right agent:
    ├─ "Book" → OPS
    ├─ "Win-back" → GROWTH
    ├─ "Info" → WEBSITE
    └─ "Feedback" → REPUTATION
         ↓
    Agent handles request
         ↓
    Can transfer back to MAIN or other agents
         ↓
    All logged to Supabase
```

---

## 📊 Monitoring

In Telnyx Dashboard:
- View calls per agent
- Monitor transfer success rate
- Check average handle time per agent
- Review transcripts

---

## 🚀 You're Live!

Once all agents are set up and tested, your multi-orchestral LolaBrain is live!

- loladesk number → loladesk workflows
- lolabrain number → multi-agent orchestration

Both numbers, fully automated, on Vercel + Telnyx!

---

## 📞 Support

See:
- **LOLABRAIN-ORCHESTRATION.md** — Full documentation
- **CONFIGURATION-CHECKLIST.md** — General checklist
- **TELNYX-TWO-NUMBERS.md** — Telnyx basics

**Questions?** Check the docs or test flow!
