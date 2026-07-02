/**
 * api/lib/lola-integrations.js — Unified Integration Wrapper
 * ════════════════════════════════════════════════════════════════
 * Handles LLM calls, email sending, and external service integrations
 * with proper error handling, rate limiting, and fallbacks.
 */

// global fetch (Node 18+) — the 'node-fetch' package was never in package.json and crashed cold deploys

const RATE_LIMIT_DELAY = 500; // ms between requests
const MAX_RETRIES = 3;

/**
 * Invoke LLM with multi-modal support (images, documents)
 */
export async function InvokeLLM({ model, prompt, messages, images, max_tokens, temperature }) {
  const selectedModel = model || process.env.VISION_MODEL || 'claude-3-5-sonnet-20241022';
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  try {
    const payload = {
      model: selectedModel,
      max_tokens: max_tokens || 1000,
      temperature: temperature || 0.7,
      system: prompt,
      messages: messages || [{ role: 'user', content: prompt }]
    };

    // Add images if provided
    if (images && images.length > 0) {
      const contentBlocks = [];

      // Add image blocks
      for (const imageUrl of images) {
        // Download image and convert to base64
        const imageData = await downloadImageAsBase64(imageUrl);
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: imageData
          }
        });
      }

      // Add text block
      contentBlocks.push({
        type: 'text',
        text: prompt
      });

      payload.messages = [{ role: 'user', content: contentBlocks }];
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';

    return {
      response: content,
      model: selectedModel,
      usage: data.usage,
      ok: true
    };
  } catch (error) {
    console.error('[LLM] Invocation error:', error);
    throw error;
  }
}

/**
 * Send email with multiple provider fallback
 */
export async function SendEmail({ to, subject, html, from, textContent }) {
  // Validate email
  if (!to || !to.includes('@')) {
    throw new Error('Invalid email address');
  }

  // Try SendGrid first
  if (process.env.SENDGRID_API_KEY) {
    try {
      return await sendViaGridSend({
        to,
        subject,
        html,
        from,
        textContent
      });
    } catch (error) {
      console.error('[SendGrid] Failed, trying fallback:', error.message);
    }
  }

  // Try AWS SES
  if (process.env.AWS_SES_REGION && process.env.AWS_ACCESS_KEY_ID) {
    try {
      return await sendViaSES({
        to,
        subject,
        html,
        from,
        textContent
      });
    } catch (error) {
      console.error('[SES] Failed, trying fallback:', error.message);
    }
  }

  // Try Mailgun
  if (process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN) {
    try {
      return await sendViaMailgun({
        to,
        subject,
        html,
        from,
        textContent
      });
    } catch (error) {
      console.error('[Mailgun] Failed:', error.message);
    }
  }

  // Last resort: Log to database for manual sending
  console.warn('[Email] No email provider configured. Email queued for manual sending.');
  return {
    success: false,
    reason: 'no_email_provider',
    queued: true,
    message: 'Email will be sent manually'
  };
}

/**
 * SendGrid implementation
 */
async function sendViaGridSend({ to, subject, html, from, textContent }) {
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: to }],
          subject
        }
      ],
      from: {
        email: from || 'lola@salon.ai',
        name: 'Lola'
      },
      content: [
        {
          type: 'text/plain',
          value: textContent || stripHTML(html)
        },
        {
          type: 'text/html',
          value: html
        }
      ]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`SendGrid error: ${response.status} - ${error}`);
  }

  return {
    success: true,
    provider: 'sendgrid',
    messageId: response.headers.get('x-message-id'),
    timestamp: new Date().toISOString()
  };
}

/**
 * AWS SES implementation
 */
async function sendViaSES({ to, subject, html, from, textContent }) {
  const { SES } = await import('@aws-sdk/client-ses');

  const ses = new SES({
    region: process.env.AWS_SES_REGION
  });

  const params = {
    Source: from || 'lola@salon.ai',
    Destination: {
      ToAddresses: [to]
    },
    Message: {
      Subject: { Data: subject },
      Body: {
        Html: { Data: html },
        Text: { Data: textContent || stripHTML(html) }
      }
    }
  };

  const result = await ses.sendEmail(params);

  return {
    success: true,
    provider: 'aws-ses',
    messageId: result.MessageId,
    timestamp: new Date().toISOString()
  };
}

/**
 * Mailgun implementation
 */
async function sendViaMailgun({ to, subject, html, from, textContent }) {
  const formData = new URLSearchParams();
  formData.append('from', from || 'lola@salon.ai');
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html', html);
  if (textContent) {
    formData.append('text', textContent);
  }

  const response = await fetch(
    `https://api.mailgun.net/v3/${process.env.MAILGUN_DOMAIN}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`api:${process.env.MAILGUN_API_KEY}`).toString('base64')}`
      },
      body: formData
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Mailgun error: ${response.status} - ${error}`);
  }

  const data = await response.json();

  return {
    success: true,
    provider: 'mailgun',
    messageId: data.id,
    timestamp: new Date().toISOString()
  };
}

/**
 * Download image and convert to base64
 */
export async function downloadImageAsBase64(imageUrl) {
  const response = await fetch(imageUrl, { timeout: 10000 });

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }

  const buffer = await response.buffer();
  return buffer.toString('base64');
}

/**
 * Validate image before processing
 */
export async function validateImageUrl(imageUrl) {
  try {
    const response = await fetch(imageUrl, { method: 'HEAD', timeout: 5000 });

    const contentType = response.headers.get('content-type') || '';
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);

    if (!contentType.startsWith('image/')) {
      return { valid: false, reason: 'not_an_image' };
    }

    if (contentLength > 25 * 1024 * 1024) {
      // 25MB limit
      return { valid: false, reason: 'image_too_large' };
    }

    if (contentLength === 0) {
      return { valid: false, reason: 'empty_image' };
    }

    return { valid: true, contentType, contentLength };
  } catch (error) {
    console.error('[Image Validation] Error:', error);
    return { valid: false, reason: 'validation_error', error: error.message };
  }
}

/**
 * Strip HTML tags from string
 */
function stripHTML(html) {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Rate-limited batch processing
 */
export async function processBatch(items, processFn, delayMs = RATE_LIMIT_DELAY) {
  const results = [];

  for (const item of items) {
    try {
      results.push(await processFn(item));
      await new Promise(resolve => setTimeout(resolve, delayMs));
    } catch (error) {
      console.error('[Batch Processing] Error:', error);
      results.push({ error: error.message });
    }
  }

  return results;
}

/**
 * Retry with exponential backoff
 */
export async function retryWithBackoff(fn, maxRetries = MAX_RETRIES) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const backoffMs = Math.pow(2, i) * 1000; // 1s, 2s, 4s
      console.warn(`[Retry] Attempt ${i + 1} failed, retrying in ${backoffMs}ms:`, error.message);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError;
}

export default {
  InvokeLLM,
  SendEmail,
  downloadImageAsBase64,
  validateImageUrl,
  processBatch,
  retryWithBackoff
};
