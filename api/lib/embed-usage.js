/**
 * api/lib/embed-usage.js — shared classification for widget-adoption data.
 *
 * Used by /api/admin/embed (platform-wide report) and /api/embed-status
 * (a salon's own "is my widget installed?" state) so the embedded-vs-
 * first-party definition never drifts between the two.
 */

export function appHost(){
  return (process.env.APP_URL || 'https://www.loladesk.com')
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
    .replace(/^www\./, '');   // apex domain: 'loladesk.com'
}

/**
 * A widget load is EMBEDDED when it ran on a page whose host is not the
 * platform itself. First-party = the platform domain in any form
 * (loladesk.com, www.loladesk.com, *.loladesk.com). Empty/missing hosts are
 * counted as first-party (never inflate the "real install" number).
 */
export function classifyHost(host, hostname){
  const h = String(host || hostname || '').toLowerCase().trim();
  const apex = appHost();
  if(!h) return 'first_party';
  if(h === apex || h.endsWith('.' + apex)) return 'first_party';
  return 'embedded';
}
