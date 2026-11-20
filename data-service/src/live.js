// Live lookup of one company at Companies House: profile, registered charges and its latest filed accounts.
// Company data only: charge holders are listed only when they are organisations, never private individuals.
// Results are cached at the edge for 24 hours and never stored in the database.
import { readAccounts } from './ixbrl.js';

const API = 'https://api.company-information.service.gov.uk';
const ORG = /\b(limited|ltd|plc|llp|bank|banking|finance|financial|capital|lending|leasing|credit|trust|trustees|fund|funding|holdings|group|corporation|corp|inc|llc|gmbh|s\.?a\.?|n\.?v\.?|b\.?v\.?|ag|partners|council|authority|society|association|ministers)\b/i;

export async function liveCompany(number, env, ctx) {
  const cacheKey = new Request(`https://data.phillips-uk.com/__cache/live/${number}/v2`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return { ...(await hit.json()), cached: true };

  const auth = 'Basic ' + btoa(env.CH_API_KEY + ':');
  const get = async path => {
    const r = await fetch(API + path, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`companies_house_${r.status}`);
    return r.json();
  };

  const profile = await get(`/company/${number}`);
  if (!profile) return { error: 'company_not_found', number };
  const [charges, filings] = await Promise.all([
    get(`/company/${number}/charges?items_per_page=100`),  // has_charges on the profile is unreliable
    get(`/company/${number}/filing-history?category=accounts&items_per_page=5`),
  ]);

  const items = charges?.items || [];
  const outstanding = items.filter(c => c.status === 'outstanding' || c.status === 'part-satisfied');
  const holders = [...new Set(outstanding.flatMap(c => (c.persons_entitled || []).map(p => p.name?.trim()).filter(Boolean)))];

  const accFiling = (filings?.items || []).find(f => f.type === 'AA' || /^accounts-with/.test(f.description || ''));
  let accounts = null;
  if (accFiling) {
    const madeUp = accFiling.description_values?.made_up_date || profile.accounts?.last_accounts?.made_up_to || null;
    accounts = { made_up_to: madeUp, filed: accFiling.date, type: profile.accounts?.last_accounts?.type || accFiling.description,
                 machine_readable: false };
    const metaUrl = accFiling.links?.document_metadata;
    if (metaUrl) {
      const meta = await (await fetch(metaUrl, { headers: { Authorization: auth, Accept: 'application/json' } })).json();
      if (meta.resources?.['application/xhtml+xml']) {
        const doc = await fetch(metaUrl + '/content', { headers: { Authorization: auth, Accept: 'application/xhtml+xml' }, redirect: 'manual' });
        const loc = doc.headers.get('Location');
        const html = loc ? await (await fetch(loc)).text() : doc.ok ? await doc.text() : null;
        if (html) Object.assign(accounts, { machine_readable: true, figures: readAccounts(html, madeUp) });
      }
    }
  }

  const pc = profile.registered_office_address?.postal_code || '';
  const result = {
    company: {
      number, name: profile.company_name, status: profile.company_status, type: profile.type,
      incorporated: profile.date_of_creation, sic_codes: profile.sic_codes || [],
      postcode_area: (pc.toUpperCase().match(/^([A-Z]{1,2})\d/) || [])[1] || null,
      next_accounts_due: profile.accounts?.next_due || null,
    },
    charges: {
      outstanding: outstanding.length, total: charges?.total_count ?? items.length,
      latest_created: outstanding.map(c => c.created_on).filter(Boolean).sort().pop() || null,
      holders: holders.filter(n => ORG.test(n)),
      holders_not_listed: holders.filter(n => !ORG.test(n)).length,  // private individuals are counted, never named
    },
    accounts,
    source: 'Companies House',
    licence: 'Contains public sector information licensed under the Open Government Licence v3.0',
    as_of: new Date().toISOString().slice(0, 10),
  };
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), { headers: { 'Cache-Control': 'max-age=86400' } })));
  return result;
}
