/**
 * api/lib/telnyx-live-mms-vision.js — In-Call MMS Vision Processing
 * ════════════════════════════════════════════════════════════════
 * During active voice call, client sends MMS (photo) to salon number.
 * Lola's vision LLM (GPT-4o) processes it in real-time and responds.
 *
 * EXAMPLE FLOW:
 * 1. Lola: "To verify your insurance covers this, please take a photo of your insurance card and text it now"
 * 2. Client sends MMS with photo to +1929-456-8227
 * 3. Telnyx webhook hits /api/telnyx-live-mms-vision
 * 4. Vision LLM analyzes card → extracts plan details
 * 5. Lola responds: "I see you're on Cigna PPO. This salon is in-network. Let me book you for..."
 *
 * USE CASES:
 * - Insurance verification (extract plan name, member ID)
 * - Before/after photos (compare previous styles)
 * - Document verification (ID, prescription, etc.)
 * - Paint color matching (client sends fabric/wall color)
 * - Product feedback (client sends photo of previous result)
 */

import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

const inCallMmsCache = new Map(); // callControlId -> { mmsData, processed, response }

/**
 * Webhook endpoint for inbound MMS during active call
 * Telnyx sends: { data: { event_type: 'messaging.incoming', payload: { from, to, text, media } } }
 */
export async function handleInCallMMS(req, res) {
  const payload = req.body?.data?.payload || {};
  const { from, to, text, media } = payload;
  
  try {
    console.log(`[MMS-VISION] Inbound MMS from ${from}. Media count: ${media?.length || 0}`);

    if (!media || media.length === 0) {
      return res.status(200).json({ processed: false, reason: 'No media attached' });
    }

    // Find active call with this phone number
    const callControlId = await findActiveCallByPhone(to);
    if (!callControlId) {
      return res.status(200).json({ processed: false, reason: 'No active call found' });
    }

    // Process first media item (usually 1 image)
    const mediaUrl = media[0].url;
    const mediaType = media[0].mime_type; // image/jpeg, image/png, etc.

    // Download image from Telnyx
    const imageBuffer = await downloadMedia(mediaUrl);

    // Send to vision LLM (GPT-4o)
    const visionResult = await processWithVision({
      image: imageBuffer,
      mediaType,
      context: text, // Client's caption (e.g., "here's my insurance card")
      callControlId
    });

    // Store result so Lola can access during call
    inCallMmsCache.set(callControlId, {
      mmsData: { from, text, mediaType },
      visionResult,
      processedAt: new Date().toISOString()
    });

    // Respond to MMS (optional: "Got your photo, Lola is analyzing...")
    await sendMmsResponse({
      to: from,
      text: '✓ Got your photo! Lola is reviewing now...',
      tenantId: await getTenantByPhone(to)
    });

    return res.status(200).json({ processed: true, callControlId, visionResult });
  } catch (e) {
    console.error(`[MMS-VISION] Processing error:`, e);
    return res.status(200).json({ processed: false, error: e.message });
  }
}

/**
 * Send image to GPT-4o Vision for analysis
 * Returns structured data extracted from image
 */
export async function processWithVision({ image, mediaType, context, callControlId }) {
  try {
    const base64Image = image.toString('base64');

    // Determine vision analysis task based on context
    const analysisPrompt = determineAnalysisTask(context);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o', // Latest multimodal model
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mediaType};base64,${base64Image}`
                }
              },
              {
                type: 'text',
                text: analysisPrompt
              }
            ]
          }
        ],
        max_tokens: 500,
        temperature: 0.3 // Low temp for factual extraction
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const analysisText = data.choices?.[0]?.message?.content || '';

    // Parse structured result
    const result = parseVisionResult(analysisText, context);

    console.log(`[MMS-VISION] Analysis complete for ${callControlId}:`, result);
    return result;
  } catch (e) {
    console.error(`[MMS-VISION] Vision processing error:`, e);
    return { error: true, message: e.message };
  }
}

/**
 * Determine what to extract from image based on client's message
 */
function determineAnalysisTask(context) {
  const ctx = (context || '').toLowerCase();

  if (ctx.includes('insurance') || ctx.includes('card')) {
    return `Extract all insurance information from this card image:
    - Insurance provider name
    - Member ID
    - Group number
    - Plan type (HMO, PPO, POS)
    - Copay amounts
    - Deductible
    - Any other visible details
    Return as JSON: { provider, member_id, group_number, plan_type, copay, deductible, other }`;
  }

  if (ctx.includes('color') || ctx.includes('match') || ctx.includes('fabric')) {
    return `Analyze the color in this image:
    - Primary color (name + hex code if possible)
    - Color family (warm, cool, neutral)
    - Tone (light, medium, dark)
    - Saturation level
    - Similar hair colors or paint names that match
    Return as JSON: { primary_color, hex_code, family, tone, saturation, similar_matches }`;
  }

  if (ctx.includes('before') || ctx.includes('after') || ctx.includes('previous') || ctx.includes('style')) {
    return `Analyze this hair style photo:
    - Current hair length (short, medium, long)
    - Current color (blonde, brunette, red, etc.)
    - Texture (straight, wavy, curly, coily)
    - Condition (good, damaged, frizzy)
    - Previous treatments visible (color fade, damage)
    Return as JSON: { length, color, texture, condition, visible_treatments, recommendations }`;
  }

  if (ctx.includes('prescription') || ctx.includes('rx') || ctx.includes('doctor')) {
    return `Extract information from this prescription/medical document:
    - Patient name
    - Doctor name
    - Medication/service recommended
    - Date
    - Any relevant details
    Return as JSON: { patient_name, doctor_name, medication_or_service, date, details }`;
  }

  if (ctx.includes('id') || ctx.includes('driver')) {
    return `Extract ID information from this document (ID, passport, license):
    - Type of ID
    - Name (if visible)
    - ID number (last 4 digits only for privacy)
    - Expiration date
    Return as JSON: { id_type, name, id_last_4, expiration_date }`;
  }

  // Default: general image analysis
  return `Analyze this image for the salon context:
    - What is shown in the image?
    - What are the main details?
    - How might this be relevant to a salon appointment?
    Return as JSON: { description, main_details, salon_relevance }`;
}

/**
 * Parse vision LLM output into structured data
 */
function parseVisionResult(analysisText, context) {
  try {
    // Try to extract JSON from response
    const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        success: true,
        data: result,
        raw_response: analysisText
      };
    }

    // Fallback: return raw text if no JSON
    return {
      success: true,
      data: { analysis: analysisText },
      raw_response: analysisText
    };
  } catch (e) {
    return {
      success: false,
      error: 'Could not parse vision result',
      raw_response: analysisText
    };
  }
}

/**
 * Lola retrieves cached MMS vision result during call
 * Used in LLM prompt to reference image analysis
 */
export async function getInCallMmsResult(callControlId) {
  const cached = inCallMmsCache.get(callControlId);
  if (!cached) {
    return null;
  }

  const ageMs = Date.now() - new Date(cached.processedAt).getTime();
  if (ageMs > 5 * 60 * 1000) {
    // Older than 5 minutes, clean up
    inCallMmsCache.delete(callControlId);
    return null;
  }

  return cached;
}

/**
 * Inject MMS vision result into Lola's system prompt
 * So she can reference it when responding
 */
export function buildMmsVisionPromptBlock(mmsResult) {
  if (!mmsResult || !mmsResult.visionResult) {
    return '';
  }

  const vr = mmsResult.visionResult;
  if (vr.error) {
    return `\nCLIENT SENT PHOTO: Unable to analyze (${vr.message}). Ask client to resend.`;
  }

  return `
CLIENT SENT PHOTO (Just received during call):
${JSON.stringify(vr.data, null, 2)}

Use this information to provide accurate responses about:
- Insurance coverage
- Color matching
- Previous style history
- Prescription details
- ID verification

If client sent insurance, mention the specific plan details.
If color match, recommend shades based on the analysis.
If ID, use for verification purposes only (never store card numbers).
`;
}

// ─────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────

async function downloadMedia(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download media: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function findActiveCallByPhone(phoneNumber) {
  // TODO: Query your call tracking system
  // For now, return placeholder
  return 'call_' + uuidv4();
}

async function getTenantByPhone(phoneNumber) {
  // TODO: Lookup tenant by phone number
  return 'tenant_default';
}

async function sendMmsResponse({ to, text, tenantId }) {
  // TODO: Send SMS/MMS via Telnyx SMS API
  console.log(`[MMS-VISION] Sending response to ${to}: ${text}`);
}

export default {
  handleInCallMMS,
  processWithVision,
  getInCallMmsResult,
  buildMmsVisionPromptBlock,
  inCallMmsCache
};
