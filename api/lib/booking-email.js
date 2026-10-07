/**
 * api/lib/booking-email.js — the confirmation email Lola sends when she books someone.
 * The text confirmation rides the booking itself (booking-repository → sendConfirmationSMS);
 * this adds the email the client gave her. Never blocks or breaks a booking: a missing
 * email provider (SENDGRID_API_KEY / SES / Mailgun) is reported as { sent:false, reason }.
 */
import { renderEmail } from './email-templates.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function sendBookingEmail({ tenant, to, name, service, when, timeoutMs = 4000 }) {
  const email = String(to || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { sent: false, reason: 'no_email' };
  try {
    const { subject, html, text } = renderEmail('confirmation', { to: email, name, tenantId: tenant?.id, tenantName: tenant?.name, service, resolution: when });
    const { SendEmail } = await import('./lola-integrations.js');
    const r = await Promise.race([
      SendEmail({ to: email, subject, html, textContent: text, from: process.env.EMAIL_FROM || process.env.SENDGRID_FROM || 'lola@loladesk.com' }),
      new Promise((resolve) => setTimeout(() => resolve({ success: false, reason: 'timeout' }), timeoutMs)),
    ]);
    const sent = !!(r && (r.success === true || r.sent === true || r.id || r.messageId));
    return sent ? { sent: true } : { sent: false, reason: r?.reason || 'not_sent' };
  } catch (e) {
    return { sent: false, reason: String(e?.message || e).slice(0, 120) };
  }
}
