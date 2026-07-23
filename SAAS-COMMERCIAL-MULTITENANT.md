# LolaDesk — Commercial Multi-Tenant SaaS Platform

## 🏢 Architecture: Enterprise-Grade Multi-Tenant System

```
┌──────────────────────────────────────────────────────────────────────┐
│                         SAAS PLATFORM                                 │
│  URL: https://www.loladesk.com/                                      │
│  Dashboard: https://www.loladesk.com/dashboard                       │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
    ┌────────┐          ┌────────┐          ┌────────┐
    │TENANT 1│          │TENANT 2│          │TENANT N│
    │Salon A │          │Salon B │          │Salon Z │
    └────────┘          └────────┘          └────────┘
        │                    │                    │
    ┌───┴────┐           ┌───┴────┐           ┌───┴────┐
    │ Data:  │           │ Data:  │           │ Data:  │
    │-Website│           │-Website│           │-Website│
    │-GMB    │           │-GMB    │           │-GMB    │
    │-Memory │           │-Memory │           │-Memory │
    └────────┘           └────────┘           └────────┘
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
    ┌────────────┐    ┌────────────┐    ┌────────────┐
    │ SUPABASE   │    │  TELNYX    │    │ELEVENLABS  │
    │• Tenant DB │    │• Voice/SMS │    │• Voice     │
    │• Memory    │    │• Numbers   │    │• Per tenant│
    │• RLS       │    │• Routing   │    │• Custom    │
    └────────────┘    └────────────┘    └────────────┘
```

---

## 🎯 3-Step Onboarding Wizard

Each tenant goes through a commercial onboarding flow:

### **Step 1: Business Information**
```
┌─────────────────────────────────────────┐
│  STEP 1: TELL US ABOUT YOUR BUSINESS    │
├─────────────────────────────────────────┤
│                                         │
│  Business Name:        [           ]    │
│  Owner Email:          [           ]    │
│  Phone Number:         [           ]    │
│  Industry:             [Salon   ▼]     │
│  City/Location:        [           ]    │
│                                         │
│              [ Continue ]               │
└─────────────────────────────────────────┘
```

### **Step 2: Ingestion URLs (THE KEY PART)**
```
┌──────────────────────────────────────────────────────────┐
│  STEP 2: CONNECT YOUR ONLINE PRESENCE                    │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  Website URL:                                            │
│  [https://www.mysalon.com                            ]   │
│  (We'll analyze services, pricing, team, hours)         │
│                                                           │
│  Google My Business URL:                                 │
│  [https://business.google.com/business/mycodes...   ]   │
│  (We'll get reviews, ratings, hours, photos)            │
│                                                           │
│  Optional: Instagram URL                                 │
│  [https://instagram.com/mysalon                      ]   │
│                                                           │
│           [ Analyze & Continue ]                         │
│                                                           │
│  🔄 Analyzing your data...                              │
│  ✓ Downloaded website                                    │
│  ✓ Analyzed 12 services                                 │
│  ✓ Extracted pricing & hours                            │
│  ✓ Found 47 reviews (4.8⭐)                             │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

### **Step 3: Configure LolaBrain**
```
┌──────────────────────────────────────────────────────────┐
│  STEP 3: CONFIGURE YOUR AI ASSISTANT                     │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  Voice for LolaBrain:  [Professional Female   ▼]        │
│                                                           │
│  Assistant Personality: [Warm & Professional   ▼]       │
│                                                           │
│  Services Lola Should Mention:                           │
│  [✓] Luxury French Balayage      [✓] Hair Extensions   │
│  [✓] Keratin Treatment           [✓] Blowout           │
│  [ ] Other: ________________                             │
│                                                           │
│  Phone Number to Assign:                                 │
│  [+1-786-449-7058               ▼]                      │
│                                                           │
│           [ Complete Setup ] or [ Edit Data ]            │
│                                                           │
│  ✓ Ingested website data                                │
│  ✓ Analyzed Google My Business                          │
│  ✓ Built tenant memory database                         │
│  ✓ Assigned phone number                                │
│  ✓ Deployed LolaBrain for your salon                    │
│                                                           │
│           🎉 You're Live! Start Receiving Calls         │
│                                                           │
└──────────────────────────────────────────────────────────┘
```

---

## 🧠 Intelligent Data Ingestion System

LolaBrain automatically ingests and structures data from:

### **1. Website Analysis**
```
GET: https://www.mysalon.com/
├─ Extract services & pricing
├─ Parse team member bios
├─ Get hours of operation
├─ Identify unique selling points
├─ Extract contact info
└─ Save as tenant memory
```

### **2. Google My Business Analysis**
```
GET: Google My Business API
├─ Business hours
├─ Address & location
├─ Phone number
├─ Website URL
├─ Services list
├─ Photos & gallery
├─ Reviews & ratings
├─ Customer feedback themes
└─ Save as tenant memory
```

### **3. Instagram Analysis** (Optional)
```
GET: Instagram public data
├─ Bio & description
├─ Recent posts
├─ Engagement patterns
├─ Hashtags used
├─ Follower count
├─ Style & aesthetics
└─ Save as tenant memory
```

---

## 💾 Tenant Memory Database

Each tenant's LolaBrain has a persistent memory:

```javascript
{
  tenant_id: "salon-uuid-123",
  business: {
    name: "MMΛ Salon",
    location: "1500 Alton Road, Miami Beach",
    phone: "+1-786-449-7058",
    website: "https://www.mmasalon.com",
    gmb_url: "https://business.google.com/...",
    instagram: "@mmasalon",
    owner: "Meddy",
    email: "meddy@mmasalon.com"
  },
  
  services: [
    {
      name: "Luxury French Balayage",
      price: 395,
      duration: "2h 30m",
      description: "Hand-painted highlights using premium techniques",
      expertise_level: "Expert"
    },
    // ... more services
  ],
  
  team: [
    {
      name: "Meddy",
      role: "Owner & Senior Stylist",
      bio: "15 years experience in luxury color...",
      specialties: ["Balayage", "Color Correction"]
    },
    // ... more team members
  ],
  
  hours: {
    tuesday: "12:00 PM - 8:00 PM",
    wednesday: "12:00 PM - 8:00 PM",
    // ...
  },
  
  reviews: {
    average_rating: 4.8,
    total_count: 147,
    themes: [
      "Professional",
      "Attention to detail",
      "Welcoming atmosphere",
      "Premium results"
    ],
    recent: [
      {
        author: "Sarah J.",
        rating: 5,
        text: "Amazing experience! Worth every penny."
      }
    ]
  },
  
  memory_log: [
    {
      timestamp: "2024-07-23T10:30:00Z",
      event: "website_ingested",
      data: { services: 12, team_members: 4 }
    },
    {
      timestamp: "2024-07-23T10:32:00Z",
      event: "gmb_analyzed",
      data: { reviews: 147, rating: 4.8 }
    },
    // ... conversation memories
  ]
}
```

---

## 🔄 System Flow: Onboarding to Live

```
1. TENANT SIGNS UP
   → Email verification
   → Account creation
   → Onboarding redirect

2. STEP 1: BUSINESS INFO
   → Name, owner, email
   → Location, industry
   → Store in Supabase

3. STEP 2: DATA INGESTION
   → Tenant provides URLs
   → System scrapes website
   → Fetches Google My Business
   → Optional: Instagram analysis
   → All data -> Supabase (tenant_memories table)
   → LolaBrain ingests data

4. STEP 3: CONFIGURE
   → Select voice preference
   → Confirm services
   → Assign phone number
   → System deploys Telnyx app

5. DEPLOYMENT
   → Tenant phone number live
   → LolaBrain knows all business data
   → Customers start calling
   → All conversations logged per tenant

6. LIVE OPERATION
   → Customer calls tenant number
   → Telnyx routes to LolaBrain
   → LolaBrain uses tenant memory
   → Responds with personalized info
   → SMS confirmations sent
   → All logged to Supabase
```

---

## 📊 Tenant Memory in Action

### **Example: Incoming Call to Tenant 1**

```
CALLER: "Hi, I'm interested in getting my hair done"

LOLABRAIN (reads tenant memory):
  ✓ Business: MMΛ Salon
  ✓ Location: 1500 Alton Road, Miami Beach
  ✓ Services: [Balayage $395, Extensions $800, ...]
  ✓ Team: [Meddy (Owner), Alice (Senior Stylist), ...]
  ✓ Hours: Tue-Sat 12PM-8PM
  ✓ Reviews: 4.8⭐ (147 reviews)
  ✓ Website: https://www.mmasalon.com

LOLABRAIN RESPONSE:
  "Hi! This is Lola from MMΛ Salon in Miami Beach. 
   We specialize in luxury hair services - from balayage 
   to extensions. Our team has over 30 years combined 
   experience. What service are you interested in today?"

CALLER: "I want a balayage"

LOLABRAIN (still using tenant memory):
  "Perfect! Our luxury French balayage is $395 and takes 
   about 2.5 hours. Our expert stylists use premium techniques. 
   When would work best for you?"
```

---

## 🔑 Key Implementation Details

### **Database Schema**

```sql
-- Tenants table
CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  owner_email VARCHAR NOT NULL UNIQUE,
  business_name VARCHAR NOT NULL,
  location VARCHAR,
  website_url VARCHAR,
  gmb_url VARCHAR,
  instagram_url VARCHAR,
  phone_number VARCHAR UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  status VARCHAR DEFAULT 'active'
);

-- Tenant memories (persistent data per tenant)
CREATE TABLE tenant_memories (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  memory_type VARCHAR, -- 'business', 'service', 'team', 'review', 'event'
  key VARCHAR,
  value JSONB,
  ingested_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tenant_id, memory_type, key)
);

-- Ingestion logs (track what was analyzed)
CREATE TABLE ingestion_logs (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  source VARCHAR, -- 'website', 'gmb', 'instagram'
  status VARCHAR, -- 'pending', 'success', 'error'
  data_points_extracted INT,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Row-level security: tenant only sees their own data
ALTER TABLE tenant_memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_memory_policy
  ON tenant_memories
  FOR ALL
  USING (tenant_id = current_user_id());
```

### **Ingestion API Endpoints**

```javascript
// POST /api/onboarding/ingest-website
{
  tenant_id: "uuid",
  website_url: "https://www.salon.com",
  gmb_url: "https://business.google.com/...",
  instagram_url: "https://instagram.com/..."
}
// Returns: 
// { status: 'success', data_points: 47, memory_stored: true }

// GET /api/tenant/memory/{tenant_id}
// Returns: Full memory object with all ingested data

// GET /api/tenant/memory/{tenant_id}/{memory_type}
// Returns: Specific memory (e.g., services, team, reviews)
```

---

## 🧬 How LolaBrain Remembers Each Tenant

### **On Phone Call:**

1. **Incoming Call Detection**
   ```
   Telnyx webhook → /api/telnyx-voice
   payload.to = tenant_phone_number
   ```

2. **Tenant Lookup**
   ```sql
   SELECT tenant_id FROM tenants WHERE phone_number = '+1-786-449-7058'
   Result: tenant_id = "salon-uuid-123"
   ```

3. **Memory Retrieval**
   ```sql
   SELECT * FROM tenant_memories WHERE tenant_id = 'salon-uuid-123'
   Result: Full tenant business data + conversation history
   ```

4. **System Prompt Injection**
   ```javascript
   const systemPrompt = `
   You are Lola, the AI assistant for ${tenant.business_name}.
   
   BUSINESS INFO:
   Location: ${tenant.location}
   Phone: ${tenant.phone_number}
   Website: ${tenant.website_url}
   
   SERVICES:
   ${tenant.services.map(s => `- ${s.name}: $${s.price}`).join('\n')}
   
   TEAM:
   ${tenant.team.map(t => `- ${t.name}: ${t.specialties.join(', ')}`).join('\n')}
   
   RECENT REVIEWS (${tenant.reviews.average_rating}⭐):
   ${tenant.reviews.recent.map(r => `"${r.text}" - ${r.author}`).join('\n')}
   
   CONVERSATION HISTORY:
   ${conversationHistory}
   `;
   ```

5. **LLM Call with Tenant Context**
   ```
   Telnyx Inference API
   system: (injected prompt with all tenant data)
   messages: (includes call transcript)
   Result: Personalized response for that specific tenant
   ```

6. **Response & Logging**
   ```
   Synthesize → ElevenLabs (tenant's custom voice)
   Return TeXML → Telnyx
   Log conversation → Supabase (tenant-isolated)
   ```

---

## ✅ Multi-Tenant Isolation

### **Row-Level Security (RLS)**

Every table with tenant data has RLS enabled:

```sql
-- Any query runs in context of current_tenant_id
-- Tenant A can NEVER see Tenant B's data

SELECT * FROM tenant_memories
WHERE tenant_id = current_user_tenant_id()
-- Query ONLY returns rows where tenant_id matches
```

### **URL Routing**

```
loladesk.com/dashboard → Shows tenant's own dashboard only
/api/tenant/data → Returns only authenticated tenant's data
/api/calls → Shows only this tenant's calls
/api/revenue → Shows only this tenant's revenue
```

### **Phone Number Mapping**

```
Tenant A phone: +1-786-449-7058 → tenant_id = uuid-a
Tenant B phone: +1-305-555-1234 → tenant_id = uuid-b
Tenant C phone: +1-954-444-5678 → tenant_id = uuid-c

Each phone number → unique tenant → isolated data → separate Telnyx app
```

---

## 💰 Commercial SaaS Pricing Model

### **Suggested Tiers:**

```
STARTER PLAN: $99/month
├─ 1 phone number
├─ Basic analytics
├─ Upto 500 calls/month
└─ Email support

GROWTH PLAN: $299/month
├─ 2 phone numbers
├─ Advanced analytics
├─ Upto 2000 calls/month
├─ SMS confirmations
└─ Priority support

ENTERPRISE PLAN: Custom
├─ Unlimited phone numbers
├─ White-label option
├─ Custom integrations
├─ Dedicated account manager
└─ 24/7 support
```

### **Billing Integration:**

```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants(id),
  plan VARCHAR, -- 'starter', 'growth', 'enterprise'
  status VARCHAR, -- 'active', 'cancelled', 'past_due'
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  stripe_subscription_id VARCHAR,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Auto-cancel if payment fails
-- Auto-upgrade if tenant reaches usage limit
-- Track usage per tenant
```

---

## 📈 SaaS Dashboard Features

Each tenant sees their own analytics:

```
Dashboard for Tenant A:
├─ Call Analytics
│  ├─ Total calls this month
│  ├─ Conversion rate (calls → bookings)
│  ├─ Average call duration
│  └─ Peak hours
│
├─ Revenue Tracking
│  ├─ Bookings from calls
│  ├─ Revenue per call
│  ├─ Monthly trends
│  └─ Top services booked
│
├─ Customer Insights
│  ├─ New vs returning callers
│  ├─ Geographic distribution
│  ├─ Service preferences
│  └─ Repeat booking rate
│
├─ LolaBrain Performance
│  ├─ Call satisfaction
│  ├─ Booking success rate
│  ├─ Response quality
│  └─ Improvement suggestions
│
└─ Settings
   ├─ Edit business info
   ├─ Update services/pricing
   ├─ Change voice/personality
   └─ Manage integrations
```

---

## 🚀 Deployment Architecture

```
SaaS Platform
│
├─ Frontend: Next.js + Vercel
│  ├─ Marketing homepage (loladesk.com)
│  ├─ Onboarding wizard (Step 1-3)
│  └─ Tenant dashboard
│
├─ Backend: Vercel Serverless
│  ├─ /api/auth/* (signup, login)
│  ├─ /api/onboarding/* (3-step wizard)
│  ├─ /api/ingest/* (website, GMB analysis)
│  ├─ /api/telnyx-voice (voice calls)
│  ├─ /api/telnyx-sms (SMS messages)
│  └─ /api/tenant/* (tenant data)
│
├─ Data: Supabase PostgreSQL
│  ├─ tenants table
│  ├─ tenant_memories table
│  ├─ conversations table
│  ├─ subscriptions table
│  └─ (all tenant-isolated with RLS)
│
├─ Voice: Telnyx
│  ├─ 1 app per tenant
│  ├─ 1 number per tenant
│  └─ Routes to LolaBrain
│
├─ AI: Telnyx Inference + ElevenLabs
│  ├─ Tenant-specific system prompts
│  ├─ Tenant-specific voice
│  └─ Persistent tenant memory
│
└─ Ingestion: Custom Services
   ├─ Website scraper
   ├─ GMB API client
   ├─ Data processor
   └─ Memory storage
```

---

## 🎯 Next Steps to Build This

1. **Update Database Schema** → Add tenant isolation
2. **Create Onboarding Flow** → 3-step wizard UI
3. **Build Ingestion Engine** → Website + GMB scraping
4. **Enhance LolaBrain** → Tenant memory injection
5. **Add Billing System** → Stripe integration
6. **Deploy as SaaS** → Multi-tenant Vercel deployment

This is a **real commercial SaaS** that can scale to thousands of salons!

---

## 📝 Commercial SaaS Checklist

- [ ] Multi-tenant database with RLS
- [ ] Tenant onboarding (3-step wizard)
- [ ] Data ingestion (Website + GMB)
- [ ] Persistent tenant memory
- [ ] Billing & subscriptions
- [ ] Tenant dashboard with analytics
- [ ] Phone number management
- [ ] Voice customization per tenant
- [ ] Email notifications
- [ ] Support ticketing
- [ ] White-label options
- [ ] API for partners

**This transforms LolaDesk from a personal app into enterprise-grade SaaS!**
