/**
 * api/lib/setup/telecom-tools.js — Lola's setup tools for the salon's phone line and texting.
 * ══════════════════════════════════════════════════════════════════════════════════════
 * Contract (wired in by the lead into the owner brain):
 *   SETUP_TOOLS   — function-tool definitions
 *   SETUP_CONFIRM — tools that spend money or are irreversible: without args.confirmed === true
 *                   they return a preview with needs_confirmation:true and do nothing.
 *   runSetupTool({ tenant, name, args, req }) → { ok, say, ui?, needs_confirmation?, suggestions?, data? }
 * Tools never throw and only ever say plain words (no ids, no Telnyx jargon).
 * Multi-turn collection: port_my_number / register_texting accept whatever the owner just said,
 * save it, and ask for exactly what's still missing (one or two things at a time).
 */
import * as E from './telecom.js';

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const CONFIRMED = S('boolean', 'Only true after the owner clearly said yes to the preview you just read them.');

export const SETUP_TOOLS = [
  fn('setup_status', 'Where the salon stands on its phone line (Lola number, call forwarding, moving their number) and business texting registration, plus the one next step. Use when the owner asks "is my phone set up?", "what\'s left?", "can clients text me?".'),
  fn('get_number', 'Give Lola her own phone number (included in the plan). First call without confirmed to get a number to offer; read it to the owner; call again with confirmed:true and the same phone_number once they say yes.', {
    area_code: S('string', 'Preferred 3-digit US area code, if the owner said one.'),
    phone_number: S('string', 'The exact number you offered (from the preview), when confirming.'),
    confirmed: CONFIRMED,
  }),
  fn('forward_my_number', 'Keep the salon\'s existing number and forward missed/busy calls to Lola. Gives the exact codes to dial for their carrier.', {
    carrier: S('string', 'The salon phone\'s carrier: AT&T, T-Mobile, Verizon, or landline/business line (Comcast, Spectrum, RingCentral...).'),
  }),
  fn('forwarding_test', 'After the owner dialed the forwarding codes: LolaDesk calls the salon number to prove missed calls reach Lola.', {
    salon_number: S('string', 'The salon number clients already call.'),
  }, ['salon_number']),
  fn('port_my_number', 'Move the salon\'s existing number to Lola for good (1–3 weeks, phone keeps working meanwhile). Pass whatever details the owner just gave; the tool saves them and says exactly what is still needed. When nothing is missing it returns a preview; submit with confirmed:true only after the owner says yes (that is their authorization to transfer the number and sign the transfer letter).', {
    phone_number: S('string', 'The salon number to move.'),
    carrier: S('string', 'Current phone company (optional).'),
    entity_name: S('string', 'Name on the phone account, exactly as on the bill (business or person).'),
    auth_person_name: S('string', 'Person authorizing the transfer.'),
    account_number: S('string', 'Account number from the phone bill.'),
    pin: S('string', 'Account PIN / port-out passcode, or "none".'),
    street: S('string', 'Service street address on the bill.'),
    city: S('string', 'City.'),
    state: S('string', 'State (2 letters).'),
    zip: S('string', 'ZIP code.'),
    billing_phone_number: S('string', 'Main billing number on the account if different from the number being moved.'),
    bill_url: S('string', 'Link to a photo or PDF of a recent phone bill.'),
    no_bill: S('boolean', 'True if the owner has no bill to share.'),
    loa_url: S('string', 'Link to a signed transfer letter, if the owner has one.'),
    temporary_number: S('boolean', 'True if the owner wants a Lola number to use while the move happens.'),
    confirmed: CONFIRMED,
  }),
  fn('port_status', 'How the move of the salon\'s number is going, in plain words (syncs with the carrier first).'),
  fn('register_texting', 'Register the salon for business texting (US carrier registration) so Lola\'s texts are delivered reliably. Pass whatever the owner just said; the tool asks for what is missing (legal name, EIN or "no EIN" for sole proprietors, address, email, website; sole proprietors also their name and personal mobile for a code). When complete it returns a preview; submit with confirmed:true after the owner says yes.', {
    legal_name: S('string', 'Business legal name exactly as on IRS paperwork.'),
    ein: S('string', '9-digit EIN, or "none".'),
    no_ein: S('boolean', 'True if the owner has no EIN (sole proprietor).'),
    first_name: S('string', 'Owner first name (sole proprietor).'),
    last_name: S('string', 'Owner last name (sole proprietor).'),
    mobile: S('string', 'Owner personal mobile for the verification code (sole proprietor).'),
    street: S('string', 'Street address.'),
    city: S('string', 'City.'),
    state: S('string', 'State (2 letters).'),
    zip: S('string', 'ZIP code.'),
    email: S('string', 'Business email.'),
    website: S('string', 'Website, or "none".'),
    confirmed: CONFIRMED,
  }),
  fn('verify_texting_code', 'The verification code the owner received by text (sole-proprietor texting registration), or resend it.', {
    code: S('string', 'The digits the owner read out.'),
    resend: S('boolean', 'True to text a new code.'),
  }),
  fn('texting_status', 'Whether the salon\'s business texting registration is approved, in plain words.'),
];

export const SETUP_CONFIRM = new Set(['get_number', 'port_my_number', 'register_texting']);

const PORT_KEYS = ['phone_number', 'carrier', 'entity_name', 'auth_person_name', 'account_number', 'pin', 'street', 'city', 'state', 'zip', 'billing_phone_number', 'bill_url', 'bill_base64', 'bill_filename', 'no_bill', 'loa_url', 'loa_base64', 'loa_filename', 'temporary_number', 'email'];
const TEXT_KEYS = ['legal_name', 'ein', 'no_ein', 'first_name', 'last_name', 'mobile', 'street', 'city', 'state', 'zip', 'email', 'website'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '').map((k) => [k, o[k]]));
const out = (r, extra = {}) => {
  const res = { ok: r.ok !== false, say: r.say || 'Done.', ...extra };
  if (r.needs_confirmation) res.needs_confirmation = true;
  return res;
};

export async function runSetupTool({ tenant, name, args = {}, req } = {}) {
  try {
    if (!tenant?.id) return { ok: false, say: 'I need to know which salon this is — please sign in again.' };
    const a = args && typeof args === 'object' ? args : {};
    const confirmed = a.confirmed === true;
    switch (name) {
      case 'setup_status': {
        const p = await E.setupProgress(tenant);
        return { ok: true, say: p.say + (p.next?.say ? ' ' + p.next.say : ''), data: { line: p.line, texting: { state: p.texting.state }, next: p.next?.tool || null }, suggestions: p.next?.tool ? [p.next.tool] : [] };
      }
      case 'get_number': {
        const r = await E.getNumber(tenant, { areaCode: a.area_code || '', phoneNumber: a.phone_number || null, confirmed });
        return out(r, { data: r.phone_number ? { phone_number: r.phone_number, number: r.number } : undefined, ...(r.ok && !r.needs_confirmation && !r.already ? { suggestions: ['register_texting'] } : {}) });
      }
      case 'forward_my_number': {
        const r = await E.forwarding(tenant, { carrier: a.carrier || '' });
        return out(r, { data: r.plan ? { carrier: r.plan.carrier, steps: r.plan.steps.map((s) => ({ when: s.when, dial: s.dial || null, portal: s.portal || null, undo: s.cancel || null })) } : undefined, suggestions: r.plan ? ['forwarding_test'] : (r.needs === 'number' ? ['get_number'] : []) });
      }
      case 'forwarding_test': {
        const r = await E.forwarding(tenant, { salonNumber: a.salon_number || '', test: true });
        return out(r);
      }
      case 'port_my_number': {
        const details = pick(a, PORT_KEYS);
        if (!details.phone_number) {
          // First turn: tell them right away if the number can't move at all.
          const draft = await E.portDraft(tenant, details);
          if (!draft.ok) return out(draft);
          if (draft.in_flight) return out({ ok: true, say: (await E.portStatus(tenant)).say });
          if (draft.missing?.length) return { ok: true, say: E.portNeedSay(draft.row, draft.missing), data: { missing: draft.missing } };
        } else {
          const chk = await E.portCheck(details.phone_number);
          if (chk.portable === false) return { ok: false, say: chk.say, suggestions: ['forward_my_number'] };
        }
        const r = await E.portStart(tenant, details, { authorized: confirmed });
        return out(r, { data: r.needs ? { missing: r.needs } : undefined });
      }
      case 'port_status': return out(await E.portStatus(tenant));
      case 'register_texting': {
        const r = await E.textingRegister(tenant, pick(a, TEXT_KEYS), { confirmed });
        return out(r, { data: r.needs ? { missing: r.needs } : undefined });
      }
      case 'verify_texting_code': {
        if (a.resend === true || !a.code) return out(await E.textingSendCode(tenant));
        return out(await E.textingVerifyCode(tenant, a.code));
      }
      case 'texting_status': {
        const r = await E.textingStatus(tenant);
        return out(r, { data: r.texting ? { state: r.texting.state } : undefined });
      }
      default: return { ok: false, say: 'I don’t know how to do that one yet.' };
    }
  } catch (e) {
    console.warn('[setup/telecom-tools]', name, String(e?.message || e).slice(0, 200));
    return { ok: false, say: 'Something went wrong on my side — give me a minute and ask again. The LolaDesk team has been notified.' };
  }
}

export default { SETUP_TOOLS, SETUP_CONFIRM, runSetupTool };
