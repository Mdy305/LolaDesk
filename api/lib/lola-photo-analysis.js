/**
 * api/lib/lola-photo-analysis.js — LOLA™ Photo Analysis with Vision AI
 * ════════════════════════════════════════════════════════════════════
 * Analyzes hair photos using Claude Vision to:
 * - Assess hair condition (healthy/damaged/severely_damaged)
 * - Identify service needs and complexity
 * - Determine risk level (low/medium/high)
 * - Generate client-friendly responses
 * - Provide stylist consultation notes
 */

import { InvokeLLM, validateImageUrl, processBatch, retryWithBackoff } from './lola-integrations.js';
import { createHash } from 'crypto';

// Configuration
const VISION_MODEL = process.env.VISION_MODEL || 'claude-3-5-sonnet-20241022';
const REPLY_MODEL = process.env.REPLY_MODEL || 'claude-3-5-haiku-20241022';
const ANALYSIS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// In-memory cache for analysis results
const analysisCache = new Map();

/**
 * Analyze single hair photo with validation and caching
 */
export async function analyzeHairPhoto(imageUrl, clientMessage = '', tenantId = null) {
  try {
    // Step 1: Validate image
    const validation = await validateImageUrl(imageUrl);
    if (!validation.valid) {
      console.warn(`[Photo] Image validation failed: ${validation.reason}`);
      return {
        condition: 'unknown',
        riskLevel: 'high',
        requiresConsultation: true,
        notes: `Unable to analyze photo (${validation.reason}). Manual review required.`,
        validated: false
      };
    }

    // Step 2: Check cache
    const cacheKey = createHash('sha256').update(imageUrl).digest('hex');
    const cached = getCachedAnalysis(cacheKey);
    if (cached) {
      console.log('[Photo] Using cached analysis for', cacheKey);
      return cached;
    }

    // Step 3: Analyze with retry logic
    const analysis = await retryWithBackoff(async () => {
      const result = await InvokeLLM({
        model: VISION_MODEL,
        images: [imageUrl],
        prompt: buildAnalysisPrompt(clientMessage),
        max_tokens: 600,
        temperature: 0.2
      });

      return parseAnalysisResponse(result.response);
    }, 2);

    // Step 4: Add metadata and cache
    analysis.analyzedAt = Date.now();
    analysis.photoUrl = imageUrl;
    analysis.validated = true;
    analysis.tenantId = tenantId;

    analysisCache.set(cacheKey, analysis);

    return analysis;
  } catch (error) {
    console.error('[Photo Analysis] Error:', error);
    return {
      condition: 'unknown',
      riskLevel: 'high',
      requiresConsultation: true,
      notes: 'Unable to analyze photo. Manual review required.',
      error: error.message
    };
  }
}

/**
 * Analyze multiple photos with rate limiting
 */
export async function analyzeMultiplePhotos(imageUrls, clientMessage = '', tenantId = null) {
  try {
    // Process sequentially with delays to avoid rate limiting
    const analyses = await processBatch(
      imageUrls,
      url => analyzeHairPhoto(url, clientMessage, tenantId),
      500 // 500ms delay between requests
    );

    const validAnalyses = analyses.filter(a => !a.error);

    return {
      photoCount: imageUrls.length,
      validPhotoCount: validAnalyses.length,
      analyses: validAnalyses,
      overallRiskLevel: getHighestRisk(validAnalyses),
      requiresConsultation: validAnalyses.some(a => a.requiresConsultation),
      summary: generatePhotoSummary(validAnalyses),
      allPhotosAnalyzed: validAnalyses.length === imageUrls.length
    };
  } catch (error) {
    console.error('[Photo Batch Analysis] Error:', error);
    return {
      photoCount: imageUrls.length,
      validPhotoCount: 0,
      analyses: [],
      overallRiskLevel: 'high',
      requiresConsultation: true,
      summary: { mainConcerns: ['Unable to analyze photos'], overallCondition: 'unknown' },
      allPhotosAnalyzed: false,
      error: error.message
    };
  }
}

/**
 * Generate client-friendly response based on analysis
 */
export async function generatePhotoResponse(analysis, context = {}) {
  try {
    if (!analysis || analysis.riskLevel === 'unknown') {
      return {
        text: "Thanks for the pic! Let me have a specialist take a closer look and get back to you! 🤍",
        confidence: 0.5
      };
    }

    const prompt = buildResponsePrompt(analysis, context);

    const result = await InvokeLLM({
      model: REPLY_MODEL,
      prompt,
      max_tokens: 100,
      temperature: 0.7
    });

    const text = result.response.trim();

    return {
      text,
      confidence: analysis.riskLevel === 'low' ? 0.95 : 0.75,
      riskLevel: analysis.riskLevel,
      shouldEscalate: analysis.riskLevel === 'high'
    };
  } catch (error) {
    console.error('[Photo Response] Error:', error);

    // Fallback response
    if (analysis?.riskLevel === 'low') {
      return {
        text: "Perfect! Your hair looks great. Let me get you booked! 💁‍♀️",
        confidence: 0.5,
        riskLevel: analysis.riskLevel
      };
    }

    return {
      text: "Thanks for the pic! Let me have one of our color specialists reach out to create the perfect plan for you 🤍",
      confidence: 0.5,
      riskLevel: analysis?.riskLevel || 'medium',
      shouldEscalate: true
    };
  }
}

/**
 * Moderate image for inappropriate content
 */
export async function moderateImage(imageUrl) {
  try {
    const result = await InvokeLLM({
      model: REPLY_MODEL,
      images: [imageUrl],
      prompt: `Analyze this image for content appropriateness.

Is this image appropriate for a professional hair salon context?

Return ONLY JSON:
{
  "appropriate": true|false,
  "reason": "brief explanation",
  "category": "hair_photo|selfie|inappropriate|unclear"
}`,
      max_tokens: 100,
      temperature: 0.1
    });

    return parseJSON(result.response);
  } catch (error) {
    console.error('[Image Moderation] Error:', error);
    return {
      appropriate: false,
      reason: 'Unable to verify image content',
      category: 'unclear'
    };
  }
}

/**
 * Build analysis prompt with context
 */
function buildAnalysisPrompt(clientMessage) {
  return `You are LOLA's advanced hair analysis AI. Analyze this hair photo with professional expertise.

${clientMessage ? `CLIENT MESSAGE: "${clientMessage}"` : ''}

ANALYZE:
1. Hair condition (healthy/damaged/severely_damaged)
2. Current color (natural, dyed, highlighted, ombre, etc)
3. Texture (straight, wavy, curly, coily, mixed)
4. Length (very short, short, shoulder, mid-length, long, very long)
5. Specific concerns (damage, breakage, color fade, frizz, split ends, etc)
6. Recommended service type and estimated duration
7. Service complexity (simple/moderate/complex)
8. Risk level (low/medium/high) - high if damage risks exist
9. Consultation needed? (true/false)
10. Stylist notes for manual review

Return ONLY JSON:
{
  "condition": "healthy|damaged|severely_damaged",
  "currentColor": "description",
  "texture": "straight|wavy|curly|coily|mixed",
  "length": "very_short|short|shoulder|mid_length|long|very_long",
  "concerns": ["concern1", "concern2"],
  "recommendedService": "service name",
  "estimatedDurationMinutes": 60,
  "complexity": "simple|moderate|complex",
  "riskLevel": "low|medium|high",
  "requiresConsultation": true|false,
  "styleNotes": "observations for stylist"
}`;
}

/**
 * Build client-friendly response prompt
 */
function buildResponsePrompt(analysis, context) {
  return `You are LOLA at a professional salon. A client sent a hair photo.

ANALYSIS RESULTS:
- Condition: ${analysis.condition}
- Current color: ${analysis.currentColor}
- Risk level: ${analysis.riskLevel}
- Recommended: ${analysis.recommendedService}
${context.clientMessage ? `\n- Client message: "${context.clientMessage}"` : ''}

Generate a warm, professional response that:
1. Acknowledges you saw the photo
2. Mentions 1-2 key observations
3. Either:
   - Confirms they can book (if low risk): "Let me get you booked!"
   - Says specialist will reach out (if medium/high risk): "One of our specialists will reach out..."

Keep it SHORT (2-3 sentences max). Tone: Valley-girl luxe, friendly, professional.

Return ONLY the response text (no JSON).`;
}

/**
 * Parse analysis JSON response
 */
function parseAnalysisResponse(text) {
  try {
    const cleaned = text
      .replace(/```json\n?/g, '')
      .replace(/```/g, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    // Validate required fields
    if (!parsed.riskLevel) {
      throw new Error('Missing riskLevel field');
    }

    return parsed;
  } catch (error) {
    console.error('[Photo Parse] Error:', error);
    return {
      condition: 'unknown',
      riskLevel: 'high',
      requiresConsultation: true,
      notes: 'Parse error: Unable to analyze photo'
    };
  }
}

/**
 * Get cached analysis if exists and not expired
 */
function getCachedAnalysis(cacheKey) {
  const cached = analysisCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  const age = Date.now() - cached.analyzedAt;

  if (age > ANALYSIS_CACHE_TTL) {
    analysisCache.delete(cacheKey);
    return null;
  }

  return cached;
}

/**
 * Get highest risk level from analyses
 */
function getHighestRisk(analyses) {
  const risks = analyses.map(a => a.riskLevel);

  if (risks.includes('high')) return 'high';
  if (risks.includes('medium')) return 'medium';
  return 'low';
}

/**
 * Generate summary from multiple photo analyses
 */
function generatePhotoSummary(analyses) {
  const concerns = [...new Set(analyses.flatMap(a => a.concerns || []))];
  const conditions = analyses.map(a => a.condition);
  const colors = analyses.map(a => a.currentColor).filter(Boolean);
  const textures = analyses.map(a => a.texture).filter(Boolean);

  const overallCondition = conditions.includes('severely_damaged')
    ? 'severely_damaged'
    : conditions.includes('damaged')
      ? 'damaged'
      : 'healthy';

  return {
    mainConcerns: concerns.slice(0, 5),
    overallCondition,
    uniqueColors: [...new Set(colors)],
    uniqueTextures: [...new Set(textures)],
    recommendedServices: analyses.map(a => a.recommendedService).filter(Boolean)
  };
}

/**
 * Parse generic JSON with fallback
 */
function parseJSON(text) {
  try {
    const cleaned = text
      .replace(/```json\n?/g, '')
      .replace(/```/g, '')
      .trim();

    return JSON.parse(cleaned);
  } catch {
    return {};
  }
}

/**
 * Clear cache (for testing or manual reset)
 */
export function clearAnalysisCache() {
  analysisCache.clear();
  console.log('[Photo] Analysis cache cleared');
}

/**
 * Get cache stats
 */
export function getCacheStats() {
  return {
    size: analysisCache.size,
    maxTTL: ANALYSIS_CACHE_TTL
  };
}

export default {
  analyzeHairPhoto,
  analyzeMultiplePhotos,
  generatePhotoResponse,
  moderateImage,
  clearAnalysisCache,
  getCacheStats
};
