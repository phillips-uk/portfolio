// Translates between Fetch API Request/Response and the Netlify Functions (Lambda-style) event/result
// shapes, so the existing netlify/functions/*.js handlers run unchanged on Workers.

export async function toEvent(request, url, extraQuery = {}) {
  const headers = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

  // Never trust a client-supplied value for the headers the app treats as authoritative.
  delete headers['x-nf-client-connection-ip'];
  delete headers['client-ip'];
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) {
    headers['x-nf-client-connection-ip'] = clientIp;
    headers['x-forwarded-for'] = clientIp;
  }
  headers['x-forwarded-proto'] = 'https';

  const queryStringParameters = {};
  for (const [k, v] of url.searchParams) queryStringParameters[k] = v;
  Object.assign(queryStringParameters, extraQuery);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return {
    httpMethod: request.method,
    path: url.pathname,
    rawUrl: url.href,
    rawQuery: url.search.replace(/^\?/, ''),
    headers,
    multiValueHeaders: {},
    queryStringParameters,
    multiValueQueryStringParameters: {},
    body: hasBody ? await request.text() : null,
    isBase64Encoded: false,
  };
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

export function fromResult(result) {
  const r = result || {};
  const status = r.statusCode || 200;
  const headers = new Headers();
  for (const [k, v] of Object.entries(r.headers || {})) if (v != null) headers.set(k, String(v));
  for (const [k, vals] of Object.entries(r.multiValueHeaders || {})) for (const v of vals) headers.append(k, String(v));

  let body = r.body ?? null;
  if (body != null && r.isBase64Encoded) {
    const bin = atob(body);
    body = Uint8Array.from(bin, c => c.charCodeAt(0));
  }
  if (NULL_BODY_STATUS.has(status)) body = null;
  return new Response(body, { status, headers });
}
