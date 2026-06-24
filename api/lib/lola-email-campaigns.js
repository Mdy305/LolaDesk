/**
 * api/lib/lola-email-campaigns.js — LOLA™ Email Campaigns with Automation
 * ═══════════════════════════════════════════════════════════════════════
 * Automated, personalized email follow-ups triggered by:
 * - Browse without booking
 * - High-ticket service inquiries
 * - Post-booking confirmations
 * - Inactive client re-engagement
 * - VIP-exclusive offers
 * - Seasonal promotions
 */

import { InvokeLLM, SendEmail } from './lola-integrations.js';
import { db } from './db.js';

/**
 * Campaign type definitions
 */
export const CAMPAIGN_TYPES = {
  FOLLOW_UP_BROWSING: 'follow_up_browsing',
  FOLLOW_UP_HIGH_TICKET: 'follow_up_high_ticket',
  POST_BOOKING: 'post_booking',
  INACTIVE_CLIENT: 'inactive_client',
  VIP_EXCLUSIVE: 'vip_exclusive',
  SEASONAL: 'seasonal'
};

/**
 * Send personalized follow-up email with proper tenant isolation
 */
export async function sendFollowUpEmail(clientId, campaignType, context = {}, tenantId) {
  try {
    if (!tenantId) {
      throw new Error('tenantId required for email campaigns');
    }

    // Fetch client with tenant verification
    const client = await db.query(
      `SELECT c.* FROM clients c 
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [clientId, tenantId]
    );

    if (!client || client.rows.length === 0) {
      console.log('[Campaigns] Client not found or unauthorized:', clientId);
      return { success: false, reason: 'client_not_found' };
    }

    const clientData = client.rows[0];

    if (!clientData.email) {
      console.log('[Campaigns] No email for client:', clientId);
      return { success: false, reason: 'no_email' };
    }

    // Fetch tenant for branding
    const tenant = await db.query(
      `SELECT * FROM tenants WHERE id = $1`,
      [tenantId]
    );

    const tenantData = tenant.rows[0] || {};

    // Generate personalized email content
    const emailContent = await generateEmailContent(clientData, campaignType, context, tenantData);

    // Send email
    const emailResult = await SendEmail({
      to: clientData.email,
      subject: emailContent.subject,
      html: emailContent.html,
      textContent: emailContent.text,
      from: emailContent.from
    });

    if (!emailResult.success && emailResult.queued) {
      console.warn('[Campaigns] Email queued for manual sending');
    }

    // Track campaign send
    await trackCampaignSend({
      clientId,
      tenantId,
      campaignType,
      emailContent,
      sendResult: emailResult
    });

    return {
      success: emailResult.success,
      reason: emailResult.reason || 'sent',
      messageId: emailResult.messageId,
      provider: emailResult.provider
    };
  } catch (error) {
    console.error('[Campaigns] Send email error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Generate personalized email content using AI
 */
async function generateEmailContent(client, campaignType, context, tenant) {
  const prompt = getCampaignPrompt(campaignType, client, context, tenant);

  const result = await InvokeLLM({
    model: process.env.REPLY_MODEL || 'claude-3-5-sonnet-20241022',
    prompt,
    max_tokens: 800,
    temperature: 0.8
  });

  // Parse response
  const content = parseEmailContent(result.response);

  // Build HTML email with unsubscribe footer
  const html = buildEmailHTML(content, client, context.unsubscribeToken);

  return {
    subject: content.subject,
    html,
    text: stripHTML(html),
    preview: content.preview,
    from: `LOLA at ${tenant.name || 'Salon'} <${process.env.EMAIL_FROM || 'noreply@salon.ai'}>`
  };
}

/**
 * Get campaign-specific prompt
 */
function getCampaignPrompt(campaignType, client, context, tenant) {
  const baseContext = `
SALON: ${tenant.name || 'Salon'}
CLIENT PROFILE:
- Name: ${client.name || 'there'}
- VIP Status: ${client.vip_status ? 'Yes' : 'No'}
- Previous Bookings: ${context.totalBookings || 0}
- Last Contact: ${client.last_contact ? new Date(client.last_contact).toLocaleDateString() : 'Unknown'}
- Total Conversations: ${context.totalConversations || 0}
`;

  const prompts = {
    [CAMPAIGN_TYPES.FOLLOW_UP_BROWSING]: `${baseContext}

This client chatted with LOLA but didn't book. They seemed interested in: ${context.interestedService || 'hair services'}

Write a warm, casual follow-up email that:
1. References their previous conversation naturally
2. Offers to answer any remaining questions
3. Makes booking easy with a direct link
4. Feels personal, not automated
5. Includes unsubscribe link at bottom

Tone: Friendly, valley-girl luxe, helpful, not pushy
Length: 3-4 short paragraphs max

Return JSON:
{
  "subject": "email subject line",
  "preview": "preview text (50 chars max)",
  "greeting": "personalized greeting",
  "body": "main email body (HTML-friendly, use <p> tags)",
  "cta": "call to action text"
}`,

    [CAMPAIGN_TYPES.FOLLOW_UP_HIGH_TICKET]: `${baseContext}

This client asked about: ${context.service || 'color correction'}

They sent photos and we flagged it as high-ticket needing specialist consultation.

Write a check-in email that:
1. Confirms we got their inquiry
2. References their specific concern
3. Sets expectation for specialist contact
4. Keeps them warm and interested
5. Includes unsubscribe link at bottom

Return same JSON format.`,

    [CAMPAIGN_TYPES.POST_BOOKING]: `${baseContext}

This client just booked! Service: ${context.service || 'appointment'}
Booking date: ${context.bookingDate || 'upcoming'}

Write a warm confirmation/pre-arrival email that:
1. Confirms their booking details
2. Gets them excited about their appointment
3. Asks any prep questions
4. Includes unsubscribe link at bottom

Return same JSON format.`,

    [CAMPAIGN_TYPES.INACTIVE_CLIENT]: `${baseContext}

We haven't heard from ${client.name || 'this client'} in ${context.daysSinceContact || 30}+ days.
They've booked ${context.totalBookings || 0} times before, so they're a past customer.

Write a friendly re-engagement email that:
1. Feels like a natural check-in (not desperate)
2. Mentions new services or seasonal offers
3. Makes it easy to reconnect
4. Includes unsubscribe link at bottom

Return same JSON format.`,

    [CAMPAIGN_TYPES.VIP_EXCLUSIVE]: `${baseContext}

This is a VIP client! ${context.totalBookings || 0} bookings, loyal customer.

Write an exclusive VIP offer email that:
1. Thanks them for their loyalty
2. Offers exclusive VIP benefit/discount
3. Makes them feel special and valued
4. Limited time to create urgency
5. Includes unsubscribe link at bottom

Offer: ${context.offer || 'exclusive discount'}
Discount: ${context.discount || '15%'}

Return same JSON format.`,

    [CAMPAIGN_TYPES.SEASONAL]: `${baseContext}

Season: ${context.season || 'upcoming holiday'}
Promotion: ${context.promotion || 'seasonal offer'}

Write a seasonal/holiday email that:
1. Captures the season's vibe
2. Offers relevant seasonal service
3. Creates FOMO (limited time)
4. Includes unsubscribe link at bottom

Return same JSON format.`
  };

  return prompts[campaignType] || prompts[CAMPAIGN_TYPES.FOLLOW_UP_BROWSING];
}

/**
 * Parse email content from LLM response
 */
function parseEmailContent(text) {
  try {
    const cleaned = text
      .replace(/```json\n?/g, '')
      .replace(/```/g, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    return {
      subject: parsed.subject || 'Hello!',
      preview: parsed.preview || parsed.subject?.slice(0, 50) || 'Message from Salon',
      greeting: parsed.greeting || 'Hi there!',
      body: parsed.body || 'Thanks for reaching out!',
      cta: parsed.cta || 'Book now'
    };
  } catch (error) {
    console.error('[Email Parse] Error:', error);

    // Fallback
    return {
      subject: 'Hello from your salon!',
      preview: 'We miss you!',
      greeting: 'Hi there!',
      body: '<p>We wanted to reach out and check in with you.</p>',
      cta: 'Book now'
    };
  }
}

/**
 * Build professional HTML email with unsubscribe footer
 */
function buildEmailHTML(content, client, unsubscribeToken) {
  const unsubscribeUrl = unsubscribeToken
    ? `${process.env.APP_URL}/email/unsubscribe?token=${unsubscribeToken}`
    : '#';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { text-align: center; margin-bottom: 30px; }
    .content { background: #f9f9f9; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
    .cta-button { 
      display: inline-block; 
      background: #000; 
      color: #fff; 
      padding: 12px 30px; 
      border-radius: 4px; 
      text-decoration: none; 
      font-weight: bold; 
      margin: 20px 0;
    }
    .cta-button:hover { background: #333; }
    .footer { 
      text-align: center; 
      font-size: 12px; 
      color: #999; 
      border-top: 1px solid #ddd; 
      padding-top: 20px; 
      margin-top: 40px;
    }
    .footer a { color: #999; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>✨ Message from Your Salon</h2>
    </div>

    <div class="content">
      <p>${content.greeting}</p>
      ${content.body}
      <a href="${process.env.BOOKING_URL || '#'}" class="cta-button">${content.cta}</a>
    </div>

    <div class="footer">
      <p>
        <a href="${unsubscribeUrl}">Unsubscribe</a> | 
        <a href="${process.env.APP_URL}/preferences">Manage preferences</a>
      </p>
      <p style="margin-top: 10px; font-size: 11px;">
        © 2026 Your Salon. All rights reserved.
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Track campaign send in database
 */
async function trackCampaignSend({ clientId, tenantId, campaignType, emailContent, sendResult }) {
  try {
    await db.query(
      `INSERT INTO campaign_sends 
       (client_id, tenant_id, campaign_type, email_subject, email_from, email_html, provider, message_id, success)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        clientId,
        tenantId,
        campaignType,
        emailContent.subject,
        emailContent.from,
        emailContent.html,
        sendResult.provider || 'unknown',
        sendResult.messageId || null,
        sendResult.success === true
      ]
    );
  } catch (error) {
    console.error('[Campaign Tracking] Error:', error);
  }
}

/**
 * Schedule follow-up email
 */
export async function scheduleFollowUp(clientId, tenantId, campaignType, context, delayHours = 24) {
  try {
    const scheduledFor = new Date(Date.now() + delayHours * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO follow_up_queue 
       (client_id, tenant_id, campaign_type, context, scheduled_for)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        clientId,
        tenantId,
        campaignType,
        JSON.stringify(context),
        scheduledFor
      ]
    );

    console.log(`[Follow-up] Scheduled ${campaignType} for client ${clientId} in ${delayHours}h`);
    return { success: true, scheduledFor };
  } catch (error) {
    console.error('[Follow-up Scheduling] Error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Process queued follow-ups (call via Vercel cron or job queue)
 */
export async function processScheduledFollowUps() {
  try {
    // Find all scheduled follow-ups that are due
    const dueCampaigns = await db.query(
      `SELECT * FROM follow_up_queue 
       WHERE scheduled_for <= NOW() AND processed_at IS NULL
       LIMIT 100`
    );

    console.log(`[Campaigns] Processing ${dueCampaigns.rows.length} scheduled follow-ups`);

    const results = {
      processed: 0,
      failed: 0,
      errors: []
    };

    for (const row of dueCampaigns.rows) {
      try {
        const context = typeof row.context === 'string' ? JSON.parse(row.context) : row.context;

        const sendResult = await sendFollowUpEmail(
          row.client_id,
          row.campaign_type,
          context,
          row.tenant_id
        );

        if (sendResult.success) {
          results.processed++;

          // Mark as processed
          await db.query(
            `UPDATE follow_up_queue SET processed_at = NOW() WHERE id = $1`,
            [row.id]
          );
        } else {
          results.failed++;
          results.errors.push({ clientId: row.client_id, reason: sendResult.reason });
        }
      } catch (error) {
        results.failed++;
        results.errors.push({ clientId: row.client_id, error: error.message });
      }
    }

    console.log('[Campaigns] Follow-up processing complete:', results);
    return results;
  } catch (error) {
    console.error('[Campaign Processing] Error:', error);
    return { processed: 0, failed: 0, error: error.message };
  }
}

/**
 * Strip HTML tags
 */
function stripHTML(html) {
  return html.replace(/<[^>]*>/g, '');
}

export default {
  CAMPAIGN_TYPES,
  sendFollowUpEmail,
  scheduleFollowUp,
  processScheduledFollowUps
};
