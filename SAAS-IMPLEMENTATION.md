# SaaS Implementation: 3-Step Onboarding + Data Ingestion

## 🏗️ Technical Architecture

### **Database Schema for Multi-Tenant SaaS**

```sql
-- ═══════════════════════════════════════════════════════════════
-- TENANTS TABLE (Each salon/business is a row)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Owner info
  owner_id UUID REFERENCES auth.users(id),
  owner_email VARCHAR NOT NULL,
  owner_name VARCHAR NOT NULL,
  
  -- Business info
  business_name VARCHAR NOT NULL,
  industry VARCHAR DEFAULT 'salon',
  description TEXT,
  
  -- Contact
  location VARCHAR,
  city VARCHAR,
  state VARCHAR,
  zipcode VARCHAR,
  primary_phone VARCHAR UNIQUE,
  
  -- Online presence (from onboarding)
  website_url VARCHAR,
  gmb_url VARCHAR,
  instagram_url VARCHAR,
  
  -- LolaBrain
  phone_number VARCHAR UNIQUE,
  lolabrain_voice VARCHAR DEFAULT 'professional-female',
  lolabrain_personality VARCHAR DEFAULT 'warm-professional',
  
  -- Billing
  subscription_plan VARCHAR DEFAULT 'starter', -- starter, growth, enterprise
  stripe_customer_id VARCHAR,
  status VARCHAR DEFAULT 'onboarding', -- onboarding, active, suspended
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  onboarded_at TIMESTAMP,
  last_call_at TIMESTAMP,
  
  -- Metadata
  metadata JSONB DEFAULT '{}'
);

-- ═══════════════════════════════════════════════════════════════
-- TENANT MEMORIES (What LolaBrain knows about each tenant)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE tenant_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  -- Memory type and key
  memory_type VARCHAR NOT NULL, -- 'business', 'service', 'team', 'review', 'hour'
  memory_key VARCHAR NOT NULL,
  
  -- The actual data
  value JSONB NOT NULL,
  
  -- Metadata
  source VARCHAR, -- 'website', 'gmb', 'manual', 'conversation'
  confidence FLOAT DEFAULT 1.0, -- 0.0 to 1.0
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(tenant_id, memory_type, memory_key)
);

-- ═══════════════════════════════════════════════════════════════
-- INGESTION LOGS (Track what was analyzed)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE ingestion_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  -- What was ingested
  source VARCHAR NOT NULL, -- 'website', 'gmb', 'instagram'
  url VARCHAR,
  
  -- Results
  status VARCHAR DEFAULT 'pending', -- 'pending', 'success', 'error'
  data_points_extracted INT DEFAULT 0,
  error_message TEXT,
  
  -- Raw results
  raw_data JSONB,
  
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════
-- ROW-LEVEL SECURITY (Tenant isolation)
-- ═══════════════════════════════════════════════════════════════

-- Only authenticated users can see their own tenant
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_view_own_tenant ON tenants
  FOR SELECT
  USING (owner_id = auth.uid());

CREATE POLICY tenant_update_own_tenant ON tenants
  FOR UPDATE
  USING (owner_id = auth.uid());

-- Tenant memories: Tenants can only see their own
ALTER TABLE tenant_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_memory_view_own ON tenant_memories
  FOR SELECT
  USING (
    tenant_id = (
      SELECT id FROM tenants WHERE owner_id = auth.uid()
    )
  );

CREATE POLICY tenant_memory_manage_own ON tenant_memories
  FOR ALL
  USING (
    tenant_id = (
      SELECT id FROM tenants WHERE owner_id = auth.uid()
    )
  );
```

---

## 🎯 Step 1: Onboarding UI (3-Step Wizard)

### **Frontend: React Component**

```typescript
// app/onboarding.tsx
import React, { useState } from 'react';
import { StepOne } from '@/components/onboarding/StepOne';
import { StepTwo } from '@/components/onboarding/StepTwo';
import { StepThree } from '@/components/onboarding/StepThree';

export default function OnboardingWizard() {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    // Step 1
    businessName: '',
    ownerEmail: '',
    ownerName: '',
    industry: 'salon',
    location: '',
    city: '',
    state: '',
    phone: '',
    
    // Step 2
    websiteUrl: '',
    gmbUrl: '',
    instagramUrl: '',
    
    // Step 3
    voice: 'professional-female',
    personality: 'warm-professional',
    selectedServices: [],
    assignedPhone: '',
  });

  const [ingestionStatus, setIngestionStatus] = useState({
    status: 'idle', // idle | analyzing | success | error
    message: '',
    dataPoints: 0,
  });

  const handleStepOneSubmit = async (data: any) => {
    setFormData({ ...formData, ...data });
    setStep(2);
  };

  const handleStepTwoSubmit = async (data: any) => {
    setFormData({ ...formData, ...data });
    setIngestionStatus({ status: 'analyzing', message: 'Analyzing your business data...', dataPoints: 0 });
    
    try {
      const response = await fetch('/api/onboarding/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessName: formData.businessName,
          websiteUrl: data.websiteUrl,
          gmbUrl: data.gmbUrl,
          instagramUrl: data.instagramUrl,
        }),
      });

      const result = await response.json();
      
      if (result.ok) {
        setIngestionStatus({
          status: 'success',
          message: `Analyzed ${result.dataPoints} data points from your business!`,
          dataPoints: result.dataPoints,
        });
        setStep(3);
      } else {
        setIngestionStatus({
          status: 'error',
          message: result.error || 'Failed to analyze business data',
          dataPoints: 0,
        });
      }
    } catch (error) {
      setIngestionStatus({
        status: 'error',
        message: 'Error analyzing your data. Please try again.',
        dataPoints: 0,
      });
    }
  };

  const handleStepThreeSubmit = async (data: any) => {
    setFormData({ ...formData, ...data });
    
    try {
      const response = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const result = await response.json();
      
      if (result.ok) {
        // Redirect to dashboard
        window.location.href = '/dashboard';
      }
    } catch (error) {
      alert('Error completing onboarding. Please try again.');
    }
  };

  return (
    <div className="onboarding-wizard">
      <div className="progress-bar">
        <div className={`step ${step >= 1 ? 'active' : ''}`}>1</div>
        <div className={`connector ${step >= 2 ? 'active' : ''}`}></div>
        <div className={`step ${step >= 2 ? 'active' : ''}`}>2</div>
        <div className={`connector ${step >= 3 ? 'active' : ''}`}></div>
        <div className={`step ${step >= 3 ? 'active' : ''}`}>3</div>
      </div>

      {step === 1 && <StepOne onSubmit={handleStepOneSubmit} />}
      {step === 2 && <StepTwo onSubmit={handleStepTwoSubmit} ingestionStatus={ingestionStatus} />}
      {step === 3 && <StepThree onSubmit={handleStepThreeSubmit} formData={formData} />}
    </div>
  );
}
```

---

## 🔄 Step 2: Data Ingestion Engine

### **Backend: Ingestion API**

```javascript
// api/onboarding/ingest.js
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import cheerio from 'cheerio';
import { parseGMB } from '@/lib/gmb-parser';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { businessName, websiteUrl, gmbUrl, instagramUrl } = req.body;
  const user = req.headers['x-user-id']; // From auth middleware

  try {
    let dataPoints = 0;
    const extractedData = {};

    // ─────────────────────────────────────
    // 1. ANALYZE WEBSITE
    // ─────────────────────────────────────
    if (websiteUrl) {
      console.log(`[INGEST] Analyzing website: ${websiteUrl}`);
      
      try {
        const response = await axios.get(websiteUrl, { timeout: 10000 });
        const $ = cheerio.load(response.data);
        
        // Extract services
        const services = [];
        $('[data-service], .service, .pricing-item').each((i, el) => {
          const name = $(el).find('.service-name, .title, h3').text().trim();
          const price = $(el).find('.price, .cost').text().trim();
          const description = $(el).find('.description, .desc, p').text().trim();
          
          if (name && (price || description)) {
            services.push({ name, price, description });
            dataPoints++;
          }
        });
        
        // Extract team members
        const team = [];
        $('[data-team], .team-member, .staff').each((i, el) => {
          const name = $(el).find('.name, h3').text().trim();
          const role = $(el).find('.role, .position').text().trim();
          const bio = $(el).find('.bio, .description, p').text().trim();
          
          if (name) {
            team.push({ name, role, bio });
            dataPoints++;
          }
        });
        
        // Extract hours
        const hours = {};
        $('[data-hours], .hours, .schedule').each((i, el) => {
          const day = $(el).find('.day').text().trim().toLowerCase();
          const time = $(el).find('.time').text().trim();
          if (day && time) {
            hours[day] = time;
            dataPoints++;
          }
        });
        
        // Extract contact info
        const contact = {
          email: $('a[href^="mailto:"]').first().attr('href')?.replace('mailto:', ''),
          phone: $('a[href^="tel:"]').first().attr('href')?.replace('tel:', ''),
          address: $('[data-address], .address').first().text().trim(),
        };
        
        // Extract description/mission
        const description = $('meta[name="description"]').attr('content') || 
                           $('h1, .hero, [data-about]').first().text().trim();
        
        extractedData.website = {
          url: websiteUrl,
          services: services.slice(0, 50), // Limit to 50
          team: team.slice(0, 20), // Limit to 20
          hours,
          contact,
          description,
        };
        
        console.log(`[INGEST] Website: Found ${services.length} services, ${team.length} team members`);
      } catch (error) {
        console.error(`[INGEST] Website error: ${error.message}`);
        // Continue with other sources even if website fails
      }
    }

    // ─────────────────────────────────────
    // 2. ANALYZE GOOGLE MY BUSINESS
    // ─────────────────────────────────────
    if (gmbUrl) {
      console.log(`[INGEST] Analyzing GMB: ${gmbUrl}`);
      
      try {
        const gmbData = await parseGMB(gmbUrl);
        
        extractedData.gmb = {
          url: gmbUrl,
          rating: gmbData.rating,
          reviewCount: gmbData.reviews.length,
          reviews: gmbData.reviews.slice(0, 20), // Last 20 reviews
          hours: gmbData.hours,
          address: gmbData.address,
          phone: gmbData.phone,
          website: gmbData.website,
          photos: gmbData.photos.slice(0, 10),
          verified: gmbData.verified,
          reviewThemes: extractReviewThemes(gmbData.reviews),
        };
        
        dataPoints += 1 + gmbData.reviews.length;
        console.log(`[INGEST] GMB: Rating ${gmbData.rating}, ${gmbData.reviews.length} reviews`);
      } catch (error) {
        console.error(`[INGEST] GMB error: ${error.message}`);
      }
    }

    // ─────────────────────────────────────
    // 3. ANALYZE INSTAGRAM (optional)
    // ─────────────────────────────────────
    if (instagramUrl) {
      console.log(`[INGEST] Analyzing Instagram: ${instagramUrl}`);
      
      try {
        const igData = await parseInstagram(instagramUrl);
        
        extractedData.instagram = {
          url: instagramUrl,
          handle: igData.handle,
          bio: igData.bio,
          followerCount: igData.followers,
          engagementRate: igData.engagement,
          recentPosts: igData.posts.slice(0, 20),
          hashtags: igData.hashtags.slice(0, 30),
          aesthetic: igData.aesthetic, // color palette, style
        };
        
        dataPoints += 1 + igData.posts.length;
        console.log(`[INGEST] Instagram: ${igData.followers} followers, ${igData.posts.length} posts`);
      } catch (error) {
        console.error(`[INGEST] Instagram error: ${error.message}`);
      }
    }

    // ─────────────────────────────────────
    // 4. STORE IN SUPABASE MEMORY
    // ─────────────────────────────────────
    const tenant = await supabase
      .from('tenants')
      .select('id')
      .eq('owner_id', user)
      .single();

    if (!tenant.data) {
      return res.status(400).json({ error: 'Tenant not found' });
    }

    const tenantId = tenant.data.id;

    // Store website data
    if (extractedData.website) {
      const websiteMemories = [
        { type: 'business', key: 'website', value: extractedData.website.description },
        { type: 'services', key: 'all', value: extractedData.website.services },
        { type: 'team', key: 'all', value: extractedData.website.team },
        { type: 'hours', key: 'all', value: extractedData.website.hours },
        { type: 'contact', key: 'all', value: extractedData.website.contact },
      ];

      for (const mem of websiteMemories) {
        await supabase.from('tenant_memories').upsert({
          tenant_id: tenantId,
          memory_type: mem.type,
          memory_key: mem.key,
          value: mem.value,
          source: 'website',
          confidence: 0.95,
        });
      }
    }

    // Store GMB data
    if (extractedData.gmb) {
      const gmbMemories = [
        { type: 'reviews', key: 'all', value: extractedData.gmb.reviews },
        { type: 'rating', key: 'current', value: { rating: extractedData.gmb.rating, count: extractedData.gmb.reviewCount } },
        { type: 'hours', key: 'gmb', value: extractedData.gmb.hours },
        { type: 'contact', key: 'gmb', value: { phone: extractedData.gmb.phone, address: extractedData.gmb.address } },
        { type: 'reputation', key: 'themes', value: extractedData.gmb.reviewThemes },
      ];

      for (const mem of gmbMemories) {
        await supabase.from('tenant_memories').upsert({
          tenant_id: tenantId,
          memory_type: mem.type,
          memory_key: mem.key,
          value: mem.value,
          source: 'gmb',
          confidence: 0.90,
        });
      }
    }

    // Store Instagram data
    if (extractedData.instagram) {
      await supabase.from('tenant_memories').upsert({
        tenant_id: tenantId,
        memory_type: 'social',
        memory_key: 'instagram',
        value: extractedData.instagram,
        source: 'instagram',
        confidence: 0.85,
      });
    }

    // Log ingestion
    await supabase.from('ingestion_logs').insert({
      tenant_id: tenantId,
      source: 'onboarding',
      status: 'success',
      data_points_extracted: dataPoints,
      raw_data: extractedData,
    });

    res.status(200).json({
      ok: true,
      dataPoints,
      extractedData,
    });
  } catch (error) {
    console.error('[INGEST] Error:', error);
    res.status(500).json({ error: error.message });
  }
}

// Helper: Extract themes from reviews
function extractReviewThemes(reviews) {
  const themes = {};
  const keywords = ['professional', 'friendly', 'clean', 'talented', 'quality', 'expensive', 'quick', 'beautiful'];
  
  for (const review of reviews) {
    const text = review.text.toLowerCase();
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        themes[keyword] = (themes[keyword] || 0) + 1;
      }
    }
  }
  
  return Object.entries(themes)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([theme, count]) => ({ theme, frequency: count }));
}
```

---

## 🧠 Step 3: Tenant Memory Injection

### **How LolaBrain Uses Tenant Memory**

```javascript
// api/lola-tenant-brain.js
import { createClient } from '@supabase/supabase-js';
import { chat } from './lib/llm';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function getTenantMemory(tenantId) {
  // Get all tenant memories from database
  const { data: memories } = await supabase
    .from('tenant_memories')
    .select('*')
    .eq('tenant_id', tenantId);

  // Organize by type
  const memoryMap = {};
  for (const mem of memories) {
    if (!memoryMap[mem.memory_type]) {
      memoryMap[mem.memory_type] = {};
    }
    memoryMap[mem.memory_type][mem.memory_key] = mem.value;
  }

  return memoryMap;
}

export async function buildTenantSystemPrompt(tenantId) {
  // Get tenant basic info
  const { data: tenant } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();

  // Get tenant memory
  const memory = await getTenantMemory(tenantId);

  // Build system prompt with ALL tenant data
  const systemPrompt = `
You are LolaBrain, an AI assistant for ${tenant.business_name}.

═══════════════════════════════════════════════════════════════
BUSINESS INFORMATION
═══════════════════════════════════════════════════════════════

Name: ${tenant.business_name}
Location: ${tenant.location}
City: ${tenant.city}
Phone: ${tenant.primary_phone}
Website: ${tenant.website_url}
${tenant.gmb_url ? `Google My Business: ${tenant.gmb_url}` : ''}

═══════════════════════════════════════════════════════════════
SERVICES OFFERED
═══════════════════════════════════════════════════════════════

${
  memory.services?.all
    ? memory.services.all
        .map(
          (s) =>
            `• ${s.name}${s.price ? ` — $${s.price}` : ''}${s.duration ? ` (${s.duration})` : ''}
${s.description ? `  ${s.description}` : ''}`
        )
        .join('\n')
    : 'Services not available'
}

═══════════════════════════════════════════════════════════════
TEAM MEMBERS
═══════════════════════════════════════════════════════════════

${
  memory.team?.all
    ? memory.team.all
        .map((t) => `• ${t.name} — ${t.role}${t.bio ? `\n  ${t.bio}` : ''}`)
        .join('\n')
    : 'Team information not available'
}

═══════════════════════════════════════════════════════════════
HOURS OF OPERATION
═══════════════════════════════════════════════════════════════

${
  memory.hours?.all
    ? Object.entries(memory.hours.all)
        .map(([day, hours]) => `${day.charAt(0).toUpperCase() + day.slice(1)}: ${hours}`)
        .join('\n')
    : 'Hours not available'
}

═══════════════════════════════════════════════════════════════
CUSTOMER REVIEWS & REPUTATION
═══════════════════════════════════════════════════════════════

Rating: ${memory.rating?.current?.rating || 'N/A'} ⭐ (${memory.rating?.current?.count || 0} reviews)

What customers say:
${
  memory.reputation?.themes
    ? memory.reputation.themes.map((t) => `• ${t.theme} (${t.frequency} mentions)`).join('\n')
    : 'No review data available'
}

Recent feedback:
${
  memory.reviews?.all
    ? memory.reviews.all
        .slice(0, 3)
        .map((r) => `"${r.text}" — ${r.author} (${r.rating}⭐)`)
        .join('\n\n')
    : 'No reviews available'
}

═══════════════════════════════════════════════════════════════
HOW TO SPEAK
═══════════════════════════════════════════════════════════════

• Be warm, professional, and knowledgeable about ${tenant.business_name}
• Reference specific services, team members, and reviews when relevant
• Use the business name frequently
• Mention the team members by name when discussing services
• Share customer testimonials when appropriate
• Always use the exact pricing and duration from above
• Keep responses to 2-3 sentences for phone calls
• Be assumptive: assume callers want to book

════════════════════════════════════════════════════════════════
  `;

  return systemPrompt;
}

// When LolaBrain receives a call for this tenant
export async function respondToTenantCall(tenantId, callerSpeech) {
  const systemPrompt = await buildTenantSystemPrompt(tenantId);

  const response = await chat({
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: callerSpeech,
      },
    ],
    maxTokens: 220,
    temperature: 0.6,
  });

  return response.text;
}
```

---

## 🔐 Multi-Tenant Isolation

### **Every Tenant is Completely Isolated**

```
Tenant A (Salon 1)
├─ Database: Only sees own rows (RLS enforced)
├─ Phone: +1-786-449-7058 → tenant_id = uuid-a
├─ Memory: 47 data points ingested
├─ Calls: All logged separately
└─ Revenue: Tracked separately

Tenant B (Salon 2)
├─ Database: Only sees own rows (RLS enforced)
├─ Phone: +1-305-555-1234 → tenant_id = uuid-b
├─ Memory: 38 data points ingested
├─ Calls: All logged separately
└─ Revenue: Tracked separately

Tenant N (Salon N)
├─ Database: Only sees own rows (RLS enforced)
├─ Phone: ... unique phone → tenant_id = uuid-n
├─ Memory: X data points ingested
├─ Calls: All logged separately
└─ Revenue: Tracked separately
```

---

## 💾 Complete Onboarding Flow

```
1. TENANT SIGNS UP
   POST /api/auth/signup
   └─ Create auth user + tenant row

2. STEP 1: BUSINESS INFO
   POST /api/onboarding/step1
   └─ Update tenant basic info

3. STEP 2: CONNECT URLS
   POST /api/onboarding/ingest
   ├─ Scrape website
   ├─ Parse Google My Business
   ├─ Analyze Instagram
   └─ Store all in tenant_memories

4. STEP 3: CONFIGURE
   POST /api/onboarding/step3
   ├─ Select voice + personality
   ├─ Confirm services
   ├─ Assign phone number
   └─ Create Telnyx app for tenant

5. LIVE
   Caller dials tenant phone
   ├─ Telnyx routes to /api/telnyx-voice
   ├─ System looks up tenant
   ├─ Builds system prompt with ALL tenant memory
   ├─ LLM responds as LolaBrain for that tenant
   ├─ Response is specific to that tenant's business
   └─ Call logged to tenant_conversations table
```

---

## ✅ Commercial SaaS Deployment

This creates a **true multi-tenant SaaS** where:

✅ Each tenant has isolated data (Row-Level Security)
✅ Each tenant has their own phone number
✅ Each tenant has their own LolaBrain AI
✅ Each tenant has their own memory database
✅ Each tenant sees their own analytics
✅ Each tenant only pays for their usage

**You can scale this to 1000+ salons without code changes!**
