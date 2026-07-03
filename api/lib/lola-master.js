/**
 * api/lib/lola-master.js — LOLA™ Master Coordinator
 * ═════════════════════════════════════════════════════════════
 * Unified orchestration of all LOLA systems:
 * - Photo analysis (vision AI)
 * - Email campaigns (automation)
 * - CRM insights (client management)
 * - Intent detection (40+ core skills)
 * - Elite skills (60+ advanced operations)
 */

import photoAnalysis from './lola-photo-analysis.js';
import campaigns from './lola-email-campaigns.js';
import crm from './lola-crm.js';
import { detectLolaIntent, deterministicSkillReply } from './lola-skills.js';
import { synthesize } from './elevenlabs.js';

/**
 * Process enhanced message with full LOLA feature set
 */
export async function processEnhanced({ clientId, message, channel, metadata = {}, tenantId }) {
  try {
    if (!tenantId) {
      throw new Error('tenantId required');
    }

    // 1. Get client insights from CRM
    const clientInsights = await crm.getClientInsights(clientId, tenantId);

    // 2. Detect intent and mood
    const intent = detectLolaIntent(message);
    const mood = detectConversationMood(message);

    // 3. Handle photo if included
    let photoAnalysisResult = null;
    if (metadata.photoUrl || metadata.mediaUrl) {
      const imageUrl = metadata.photoUrl || metadata.mediaUrl;

      // Moderate image first
      const moderation = await photoAnalysis.moderateImage(imageUrl);

      if (moderation.appropriate) {
        photoAnalysisResult = await photoAnalysis.analyzeHairPhoto(imageUrl, message, tenantId);

        // If high-risk photo, generate special response
        if (photoAnalysisResult.riskLevel === 'high') {
          const photoResponse = await photoAnalysis.generatePhotoResponse(photoAnalysisResult, {
            clientMessage: message
          });

          metadata.photoAnalysis = photoAnalysisResult;
          metadata.usePhotoResponse = true;
          metadata.photoResponseText = photoResponse.text;
        }
      }
    }

    // 4. Get deterministic skill response if available
    let response = deterministicSkillReply({
      tenant: { id: tenantId, name: metadata.tenantName || 'Salon' },
      intent,
      channel,
      clientName: clientInsights?.name || ''
    });

    // 5. If no deterministic match, would call LLM here
    // (integration point with existing LLM pipeline)
    if (!response) {
      response = metadata.usePhotoResponse
        ? metadata.photoResponseText
        : `Thanks for reaching out! How can I help you today?`;
    }

    // 6. Generate voice if phone channel
    let voiceAudio = null;
    if (channel === 'phone') {
      try {
        voiceAudio = await synthesize(response);
      } catch (error) {
        console.warn('[LOLA Master] Voice synthesis failed:', error.message);
      }
    }

    // 7. Update CRM with conversation
    await crm.updateClientFromConversation(clientId, tenantId, {
      intent,
      mood,
      response,
      photoAnalysis: photoAnalysisResult
    });

    // 8. Trigger follow-up campaign if needed
    if (intent === 'booking' && !metadata.photoResponseText) {
      // Client expressed booking intent but didn't complete
      // Schedule follow-up email in 24 hours
      await campaigns.scheduleFollowUp(clientId, tenantId, campaigns.CAMPAIGN_TYPES.FOLLOW_UP_BROWSING, {
        interestedService: extractServiceFromMessage(message),
        totalBookings: clientInsights?.total_bookings || 0
      });
    }

    return {
      success: true,
      response,
      voiceAudio,
      intent,
      mood,
      photoAnalysis: photoAnalysisResult,
      clientInsights: {
        name: clientInsights?.name,
        totalBookings: clientInsights?.total_bookings,
        engagementScore: clientInsights?.engagement_score
      }
    };
  } catch (error) {
    console.error('[LOLA Master] Enhanced processing error:', error);

    // Log error
    try {
      await logError(tenantId, clientId, error);
    } catch (logError) {
      console.error('[LOLA Master] Could not log error:', logError);
    }

    return {
      success: false,
      response: "Thanks for reaching out! I had a little hiccup. A specialist will follow up with you soon! 🤍",
      error: error.message,
      intent: 'unknown',
      mood: 'neutral'
    };
  }
}

/**
 * Get analytics dashboard data
 */
export async function getAnalyticsDashboard(tenantId) {
  try {
    const vipClients = await crm.getVIPClients(tenantId);
    const followUpNeeded = await crm.getClientsForFollowUp(tenantId, 10);

    return {
      vipCount: vipClients.length,
      followUpCount: followUpNeeded.length,
      features: {
        photoAnalysis: true,
        emailCampaigns: true,
        crm: true,
        voiceSynthesis: !!process.env.ELEVENLABS_API_KEY
      },
      cacheStats: photoAnalysis.getCacheStats(),
      lastUpdated: Date.now()
    };
  } catch (error) {
    console.error('[LOLA Master] Analytics error:', error);
    return { error: error.message };
  }
}

/**
 * Run daily maintenance tasks
 */
export async function runDailyMaintenance(tenantId) {
  console.log('[LOLA] Running daily maintenance for tenant:', tenantId);

  const results = {
    followUpsSent: 0,
    errors: []
  };

  try {
    // Process scheduled follow-ups
    const followUpResult = await campaigns.processScheduledFollowUps();
    results.followUpsSent = followUpResult.processed;

    if (followUpResult.errors?.length > 0) {
      results.errors = followUpResult.errors;
    }
  } catch (error) {
    console.error('[LOLA] Daily maintenance error:', error);
    results.errors.push(error.message);
  }

  console.log('[LOLA] Daily maintenance complete:', results);
  return results;
}

/**
 * Detect mood from message
 */
function detectConversationMood(message) {
  const text = message.toLowerCase();

  if (/excited|happy|love|amazing|great|awesome/i.test(text)) {
    return 'happy';
  }
  if (/angry|frustrated|upset|terrible|hate|worst/i.test(text)) {
    return 'frustrated';
  }
  if (/sad|disappointed|sorry|problem|issue/i.test(text)) {
    return 'sad';
  }
  if (/interested|thinking|curious|maybe/i.test(text)) {
    return 'contemplative';
  }

  return 'neutral';
}

/**
 * Extract service from message
 */
function extractServiceFromMessage(message) {
  const services = [
    'color',
    'cut',
    'styling',
    'treatment',
    'blowout',
    'ombre',
    'highlights',
    'keratin',
    'extension'
  ];

  const lower = message.toLowerCase();

  for (const service of services) {
    if (lower.includes(service)) {
      return service;
    }
  }

  return 'general service';
}

/**
 * Log error to database
 */
async function logError(tenantId, clientId, error) {
  try {
    const { db } = await import('./db.js');

    await db.query(
      `INSERT INTO error_logs (tenant_id, client_id, error_type, error_message, stack_trace)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, clientId, error.name, error.message, error.stack]
    );
  } catch (e) {
    console.error('[Error Logging] Failed:', e);
  }
}

export default {
  processEnhanced,
  getAnalyticsDashboard,
  runDailyMaintenance
};
