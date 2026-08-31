/**
 * api/lib/email-templates.js — the three product email kinds Lola sends.
 * ════════════════════════════════════════════════════════════════════
 * Pure renderers (no I/O) so they're unit-testable and provider-agnostic.
 * Every message carries an unsubscribe footer (CAN-SPAM) pointing at
 * /api/email/unsubscribe?email=…&tenant=… — the endpoint flips the client's
 * opt-out so Lola stops emailing them. Nothing here may ever log a secret.
 */

const APP_URL = () => process.env.APP_URL || 'https://www.loladesk.com';

function footerHtml(email, tenantId){
  const unsub = `${APP_URL()}/api/email/unsubscribe?email=${encodeURIComponent(String(email||''))}&tenant=${encodeURIComponent(String(tenantId||''))}`;
  return `
  <div style="margin-top:28px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#9aa0a6">
    <p><em>LOLA the front desk</em> — your salon's AI receptionist.</p>
    <p>No longer want these? <a href="${unsub}" style="color:#9aa0a6">Unsubscribe</a> · <a href="${APP_URL()}/preferences" style="color:#9aa0a6">Manage preferences</a></p>
  </div>`;
}

function gate(fragment){ return `
<div style="max-width:600px;margin:0 auto;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1d21">
  <div style="text-align:center;padding:18px 0 8px;letter-spacing:.18em;font-size:12px;font-weight:700">LOLA — the front desk</div>
  ${fragment}
</div>`; }

const cta = (label, url) => url ? `
<div style="margin:22px 0;text-align:center">
  <a href="${url}" style="display:inline-block;background:#000;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600">${label}</a>
</div>` : '';

function bodyHtml(paragraphs, ctaHtml){
  return (paragraphs||[]).map(p => `<p style="font-size:15px;line-height:1.6">${p}</p>`).join('') + (ctaHtml||'');
}

export function renderEmail(kind, { to, name, tenantId, tenantName, service, date, link, offer, resolution } = {}){
  const first = String(name||'').split(' ')[0];
  const salutation = first ? `Hi ${first},` : 'Hi there,';
  const app = APP_URL();

  let subject = 'Message from your salon';
  let paragraphs = [];
  let ctaHtml = '';
  let preview = '';

  if(kind === 'confirmation'){
    subject = `Confirmed: ${service || 'your appointment'} — ${tenantName || 'the salon'}`;
    paragraphs = [
      `${salutation}`,
      `Your appointment is confirmed${service ? ` for <strong>${service}</strong>` : ''}${resolution ? ` on <strong>${resolution}</strong>` : ''} with ${tenantName || 'the salon'}.`,
      `Need to change it? Open the booking link below to reschedule in seconds — no call needed.`
    ];
    ctaHtml = cta('View / reschedule', `${app}/book/${(tenantId||'').slice(0,8)}`);
    preview = `Your booking is locked in${service ? ` for ${service}` : ''}.`;
  }
  else if(kind === 'follow_up'){
    subject = `${tenantName || 'We'} saved a spot for you`;
    paragraphs = [
      `${salutation}`,
      `We noticed you were looking at ${service || 'our services'} and didn't finish booking.${offer ? ` Here's a ${offer} to get you in.` : ''}`,
      `The calendar moves fast — grab the slot you like and we'll handle the rest.`
    ];
    ctaHtml = cta('Book now', `${app}/book/${(tenantId||'').slice(0,8)}`);
    preview = `A spot is waiting for you.`;
  }
  else if(kind === 'review_request'){
    subject = `How was your visit with ${tenantName || 'us'}? ${first ? first + ',' : ''}`;
    paragraphs = [
      `${salutation}`,
      `Thanks for coming in. If you have a moment, a quick review helps ${tenantName || 'our salon'} more than you know.`,
      `Love your experience? Leave a review and we'll share it. Anything less, tell us directly — we want to make it right.`
    ];
    ctaHtml = cta('Leave a review', `${app}/book/${(tenantId||'').slice(0,8)}`);
    preview = `We'd love your feedback.`;
  }
  else {
    subject = String(subject || 'Message from ' + (tenantName || 'the salon'));
    const custom = Array.isArray(paragraphs) ? paragraphs : [];
    // Fallback for unknown kinds → treat as a simple message if one was given.
  }

  const html = gate(`
    ${ctaHtml ? '' : ''}
    ${bodyHtml(paragraphs, ctaHtml)}
    ${footerHtml(to, tenantId)}
  `);

  const strip = (s) => String(s||'').replace(/<[^>]*>/g, ' ').replace(/\s+/g,' ').trim();
  const text = [subject, strip(paragraphs.join(' ')), (ctaHtml ? 'Book now: ' + `${app}/book/` : ''), `Unsubscribe: ${app}/api/email/unsubscribe?email=${encodeURIComponent(String(to||''))}`].filter(Boolean).join('\n\n');

  return { subject, html, text, preview };
}

export default { renderEmail };