// Exchange rates against sterling from the European Central Bank's daily reference rates (published around 16:00 CET
// on working days). Reference rates are for information only, not dealing rates. Cached at the edge for 6 hours.
// ECB Data Portal API (the same reference rates; the www.ecb.europa.eu XML file refuses Worker requests).
const ECB = 'https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?lastNObservations=1&format=csvdata';

export async function fxRates(ctx) {
  const cacheKey = new Request('https://data.phillips-uk.com/__cache/fx/v2');
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit.json();
  const res = await fetch(ECB, { headers: { Accept: 'text/csv' } });
  if (!res.ok) throw new Error(`fx_unavailable_${res.status}`);
  // Columns: KEY, FREQ, CURRENCY, CURRENCY_DENOM, EXR_TYPE, EXR_SUFFIX, TIME_PERIOD, OBS_VALUE, ... (quoted text comes later)
  const rows = (await res.text()).trim().split('\n').slice(1).map(l => l.split(',')).map(c => [c[2], c[6], Number(c[7])]);
  const date = rows.map(r => r[1]).sort().pop();
  const eur = Object.fromEntries(rows.filter(r => r[1] === date && r[2] > 0).map(r => [r[0], r[2]]));
  if (!date || !eur.GBP) throw new Error('fx_unavailable');
  eur.EUR = 1;
  // Units of each currency per £1.
  const perGbp = Object.fromEntries(Object.entries(eur).filter(([c]) => c !== 'GBP').map(([c, r]) => [c, Math.round((r / eur.GBP) * 1e5) / 1e5]));
  const result = {
    as_of: date, base: 'GBP', rates: perGbp,
    source: 'European Central Bank euro reference exchange rates (ECB Data Portal), converted to sterling',
    note: 'Reference rates for information only, not dealing rates',
  };
  ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(result), { headers: { 'Cache-Control': 'max-age=21600' } })));
  return result;
}
