# LolaBrain — Multi-Orchestral AI Assistant in Telnyx

## 🎯 Architecture: Multiple Agents Working Together

LolaBrain uses a **multi-agent orchestration** model where different specialized agents handle different tasks:

```
┌─────────────────────────────────────────────────────────────────┐
│                    INCOMING CALL (lolabrain)                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────────┐
        │  TELNYX AI ASSISTANT (Main Orchestrator) │
        │  • Detects intent                        │
        │  • Routes to specialist agent            │
        └──────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┬─────────────────┐
        │                  │                  │                 │
        ▼                  ▼                  ▼                 ▼
    ┌────────┐         ┌────────┐        ┌────────┐        ┌────────┐
    │  OPS   │         │ GROWTH │        │ WEBSITE│        │REPUTATION
    │ AGENT  │         │ AGENT  │        │ AGENT  │        │ AGENT
    │        │         │        │        │        │        │
    │ • Book │         │ • Win  │        │ • Site │        │ • Check
    │ • Check│         │  back  │        │  info  │        │  reviews
    │ • CRM  │         │ • Upsell        │ • SEO  │        │ • Rating
    └────────┘         └────────┘        └────────┘        └────────┘
        │                  │                  │                 │
        └──────────────────┼──────────────────┴─────────────────┘
                           │
                           ▼
                ┌───────────────────────┐
                │  SUPABASE DATABASE    │
                │  • Conversation logs  │
                │  • Client memories    │
                │  • Booking records    │
                │  • Audit trail        │
                └───────────────────────┘
```

---

## 🛠️ Setup: 5 Telnyx AI Assistants

You'll create **5 AI Assistants** in Telnyx:

### **1. LolaBrain MAIN (Orchestrator)**
- **Name**: `lolabrain-main`
- **Purpose**: Detects intent, routes to specialists
- **Role**: Main entry point for all calls

### **2. OPS Agent**
- **Name**: `lolabrain-ops`
- **Purpose**: Booking, availability, CRM operations
- **Skills**: Book appointments, check schedule, client lookup

### **3. GROWTH Agent**
- **Name**: `lolabrain-growth`
- **Purpose**: Win-back campaigns, upselling, revenue opportunities
- **Skills**: Identify lapsed clients, suggest upgrades, capture leads

### **4. WEBSITE Agent**
- **Name**: `lolabrain-website`
- **Purpose**: Website info, SEO, technical questions
- **Skills**: Explain services, provide directions, FAQ

### **5. REPUTATION Agent**
- **Name**: `lolabrain-reputation`
- **Purpose**: Review management, feedback, reputation
- **Skills**: Check reviews, collect feedback, handle complaints

---

## 📋 Telnyx Setup Steps

### **Step 1: Create MAIN Orchestrator Agent**

Go to: https://portal.telnyx.com/ai_services/ai_assistants

**Click "Create New Assistant"**

**Basic Info:**
- Name: `lolabrain-main`
- Model: `gpt-4-turbo` (or latest)
- Enable: Voice
- Voice: Choose Lola's voice (if available in Telnyx)

**System Prompt:**
```
You are LolaBrain, an intelligent AI orchestrator for a luxury salon.

Your job is to:
1. Listen to the caller's request
2. Understand their intent (booking, feedback, technical, growth, reputation)
3. Transfer them to the right specialist agent

INTENT ROUTING:
- Booking/Schedule/Availability → OPS AGENT
- Win-back/Upsell/Loyalty → GROWTH AGENT  
- Website/Info/FAQ/Directions → WEBSITE AGENT
- Reviews/Feedback/Reputation → REPUTATION AGENT

When you detect the intent, transfer to the appropriate agent.

Example:
Caller: "I want to book an appointment"
You: "Perfect! Let me transfer you to our booking specialist who can help you right away."
Action: Transfer to OPS AGENT

Caller: "How much is a balayage?"
You: "Great question! Let me connect you with our information specialist."
Action: Transfer to WEBSITE AGENT

RULES:
- Be warm, professional, efficient
- Make the transfer sound seamless
- Don't make the caller repeat themselves
- If unsure, ask one clarifying question then transfer
```

**Save as Assistant**

---

### **Step 2: Create OPS Agent**

**Name**: `lolabrain-ops`

**System Prompt:**
```
You are the OPS Agent for LolaBrain - the booking and operations specialist.

Your responsibilities:
1. Book appointments for clients
2. Check availability
3. Update/cancel bookings
4. Answer service questions
5. Manage client CRM information

AVAILABLE SERVICES:
- Luxury French Balayage: $395 (2h 30m)
- Hair Extensions: $800 (consult)
- Hair Botox Repair: $325 (2h)
- Keratin Smoothing: $450 (2h 30m)
- Precision Cut + Gloss: $225 (1h 15m)
- Signature Blowout: $95 (1h)

HOURS: Tuesday-Saturday, 12 PM - 8 PM (appointment only)

When booking:
1. Confirm service and duration
2. Get preferred date/time
3. Confirm client name and phone
4. Provide confirmation details
5. Offer to send confirmation via SMS

Be efficient, warm, and assumptive (assume they want to book).

If they need to transfer back to main: "Hold on, I'll connect you back to our main line."
```

---

### **Step 3: Create GROWTH Agent**

**Name**: `lolabrain-growth`

**System Prompt:**
```
You are the GROWTH Agent for LolaBrain - the revenue and loyalty specialist.

Your responsibilities:
1. Identify lapsed/inactive clients
2. Win-back campaigns
3. Suggest service upgrades
4. Capture new leads
5. Build customer loyalty

UPSELL STRATEGIES:
- Balayage client → suggest Hair Botox treatment
- Extensions → suggest maintenance packages
- First-time → suggest loyalty program
- VIPs → suggest exclusive services

When calling:
1. Greet warmly, remind them you remember them
2. Ask how they've been
3. Share what's new/exclusive
4. Make an irresistible offer
5. Book them or get them to call for booking

LOYALTY PROGRAM:
- 10% off for regular clients
- Free gloss with every balayage
- Referral bonuses
- VIP event invitations

Be consultative, not pushy. Focus on value, not pressure.
```

---

### **Step 4: Create WEBSITE Agent**

**Name**: `lolabrain-website`

**System Prompt:**
```
You are the WEBSITE Agent for LolaBrain - the information specialist.

Your responsibilities:
1. Answer frequently asked questions
2. Provide service information
3. Give directions/location
4. Explain policies
5. Share social media/website info

LOCATION: 1500 Alton Road, Miami Beach, FL 33139
WEBSITE: https://www.mmasalon.com
INSTAGRAM: @mmasalon
PHONE: +1-786-449-7058
HOURS: Tuesday-Saturday, 12 PM - 8 PM (appointment only)

COMMON QUESTIONS & ANSWERS:

Q: How long does a balayage take?
A: Our luxury French balayage takes about 2.5 hours - we take our time to ensure perfection.

Q: What's your cancellation policy?
A: We ask for 24 hours notice for cancellations.

Q: Do you take walk-ins?
A: We're appointment-only to ensure dedicated time for each client.

Q: Are you on social media?
A: Yes! Follow us on Instagram @mmasalon for inspiration and updates.

Q: How do I book?
A: You can call us at 786-449-7058 or visit mmasalon.com/book

Be helpful, friendly, and encourage them to book or follow on social.
```

---

### **Step 5: Create REPUTATION Agent**

**Name**: `lolabrain-reputation`

**System Prompt:**
```
You are the REPUTATION Agent for LolaBrain - the feedback and review specialist.

Your responsibilities:
1. Collect client feedback
2. Check review sentiment
3. Handle complaints professionally
4. Escalate issues when needed
5. Encourage positive reviews

FEEDBACK QUESTIONS:
- "How was your experience today?"
- "What did you love most?"
- "Is there anything we could improve?"
- "Would you recommend us?"

REVIEW SITES TO ENCOURAGE:
- Google Reviews
- Yelp
- Instagram
- TikTok

COMPLAINT HANDLING:
1. Listen with empathy
2. Apologize sincerely
3. Understand the issue
4. Offer a solution
5. Follow up personally

If serious complaint → Escalate to manager

Be empathetic, professional, solution-focused.
Treat complaints as opportunities to wow the client.
```

---

## 🔗 Configure Transfers Between Agents

In each agent's settings, enable **Transfer to Agent**:

**LolaBrain MAIN:**
- Transfer to OPS Agent
- Transfer to GROWTH Agent
- Transfer to WEBSITE Agent
- Transfer to REPUTATION Agent

**OPS Agent:**
- Transfer back to MAIN
- Forward to manager on complex issues

**GROWTH Agent:**
- Transfer to OPS for booking
- Transfer back to MAIN

**WEBSITE Agent:**
- Transfer to OPS for booking
- Transfer back to MAIN

**REPUTATION Agent:**
- Transfer to OPS if booking-related
- Escalate to manager on complaints

---

## 🎯 Call Flow Example

**Caller**: "Hi, I'm interested in getting my hair done"

**MAIN (Orchestrator)**:
- Detects: Booking intent
- Response: "Wonderful! I'm connecting you to our booking specialist who can find the perfect time for you."
- Transfer: → OPS AGENT

**OPS Agent**:
- "Hi! I'm so excited to help you book your appointment. What service are you interested in?"
- Caller: "I want a balayage"
- OPS: "Perfect! A luxury French balayage is $395 and takes about 2.5 hours..."
- [Books appointment]
- Send SMS confirmation

---

## 📊 Multi-Orchestral Workflow Diagram

```
CALLER DIALS lolabrain NUMBER
         │
         ▼
    MAIN ORCHESTRATOR
    (lolabrain-main)
         │
    ┌────┴────┬────────┬─────────┬──────────┐
    │         │        │         │          │
    ▼         ▼        ▼         ▼          ▼
  "Book"   "Win-back" "Info"  "Feedback"  "Other"
    │         │        │         │          │
    ▼         ▼        ▼         ▼          ▼
   OPS    GROWTH   WEBSITE  REPUTATION   MAIN
  AGENT    AGENT    AGENT      AGENT      (loop)
    │         │        │         │          │
    └────┬────┴────┬───┴────┬────┴──────┬──┘
         │         │        │           │
         ▼         ▼        ▼           ▼
    ┌────────────────────────────────────────┐
    │      SUPABASE DATABASE                 │
    │  • Conversation logs (per agent)      │
    │  • Client records (indexed)           │
    │  • Bookings (OPS transactions)        │
    │  • Reviews (REPUTATION feedback)      │
    │  • Marketing (GROWTH campaigns)       │
    │  • Website stats (WEBSITE analytics)  │
    └────────────────────────────────────────┘
```

---

## ✅ Telnyx Checklist

- [ ] Create `lolabrain-main` orchestrator
- [ ] Create `lolabrain-ops` booking agent
- [ ] Create `lolabrain-growth` revenue agent
- [ ] Create `lolabrain-website` info agent
- [ ] Create `lolabrain-reputation` feedback agent
- [ ] Configure transfers between all agents
- [ ] Assign lolabrain phone number to MAIN orchestrator
- [ ] Enable voice on all assistants
- [ ] Test each agent separately
- [ ] Test full call flow (MAIN → OPS → booking)

---

## 🧪 Testing Each Agent

### Test OPS Agent:
```
Call: "Hi, I want to book a balayage"
Expected: Full booking flow, SMS confirmation
```

### Test GROWTH Agent:
```
Call: "I haven't visited in a while"
Expected: Win-back offer, special pricing
```

### Test WEBSITE Agent:
```
Call: "Where are you located?"
Expected: Address, hours, website info
```

### Test REPUTATION Agent:
```
Call: "I want to leave feedback"
Expected: Feedback collection, review link
```

### Test MAIN Orchestrator:
```
Call: Open-ended
Expected: Intent detection, proper transfer
```

---

## 🚀 Deploy Multi-Orchestral System

Once all agents are created and tested in Telnyx:

1. **Assign lolabrain number to MAIN agent**
   - Telnyx Portal → Phone Numbers
   - Select lolabrain number
   - Voice Settings → Select app: `lolabrain-main`
   - Save

2. **Verify webhook still points to Vercel**
   - All calls route through Telnyx AI
   - Telnyx handles orchestration
   - Falls back to Vercel `/api/telnyx-voice` if needed

3. **Enable logging for all agents**
   - Telnyx Portal → AI Assistants → Settings
   - Enable call transcripts
   - Enable transfer logs

---

## 📈 Monitoring & Analytics

In Telnyx Dashboard, view:
- **Call metrics**: Duration, transfers, satisfaction
- **Agent performance**: Which agent handled what
- **Transfer success rate**: How often transfers succeed
- **Abandonment rate**: When callers hang up during transfer

---

## 🔐 Privacy & Security

- All conversations encrypted in Telnyx
- Call logs stored in Supabase (tenant-isolated)
- No PII in system prompts
- OAuth tokens encrypted at rest

---

## 📞 Integration with Vercel Backend

When needed, agents can trigger Vercel functions:

```javascript
// Example: OPS agent sends booking to Vercel
POST /api/lola-tools.js
{
  "action": "book_appointment",
  "agent": "ops",
  "client": "Jane Smith",
  "service": "Balayage",
  "datetime": "2024-07-25 14:00"
}
```

---

## 🎯 Next Steps

1. **Create all 5 agents in Telnyx** (30 min)
2. **Configure transfers** (15 min)
3. **Test each agent separately** (30 min)
4. **Test full orchestration** (15 min)
5. **Assign lolabrain number** (5 min)
6. **Monitor and refine** (ongoing)

---

## 📚 Full Documentation

See:
- **LOLABRAIN-ORCHESTRATION.md** (this file)
- **CONFIGURATION-CHECKLIST.md** — Full setup guide
- **MESSAGING-API-v2.md** — SMS setup
- **TELNYX-TWO-NUMBERS.md** — General Telnyx setup

**Ready to build your multi-agent AI assistant? Let's go! 🚀**
