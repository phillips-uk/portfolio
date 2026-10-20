// R2-backed stand-in for @netlify/blobs. Only get/set/delete are used by this codebase.
// Each Netlify store becomes a key prefix in the BLOBS bucket ("<store>/<key>"). R2 is strongly consistent,
// so a background job always sees the files the upload function wrote moments earlier.
function bucket() {
  const b = globalThis.__phEnv && globalThis.__phEnv.BLOBS;
  if (!b) throw new Error('BLOBS R2 binding missing');
  return b;
}

function getStore(opts) {
  const store = typeof opts === 'string' ? opts : opts.name;
  const path = key => `${store}/${key}`;
  return {
    async get(key, o = {}) {
      const obj = await bucket().get(path(key));
      if (!obj) return null;
      const text = await obj.text();
      return o.type === 'json' ? JSON.parse(text) : text;
    },
    async set(key, value) {
      await bucket().put(path(key), typeof value === 'string' ? value : String(value));
    },
    async delete(key) {
      await bucket().delete(path(key));
    },
  };
}

module.exports = { getStore };
