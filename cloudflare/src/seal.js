// Sealing secrets at rest: AES-GCM with a 256-bit key held only as a Worker secret (base64), so a copy of R2 alone
// reveals nothing. Used for the Xero tokens (client-billing.js). Copied from tdo-app/src/seal.js (22 Nov 2026).
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyOf(secret) {
  const raw = unb64(String(secret || "").trim());
  if (raw.length !== 32) throw new Error("The token key must be 32 bytes, written in base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts any JSON value. */
export async function seal(secret, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(secret), new TextEncoder().encode(JSON.stringify(value)));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

/** Decrypts what seal() wrote. Throws if the key is wrong or the text was changed. */
export async function unseal(secret, text) {
  const [v, iv, ct] = String(text || "").split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("Not a sealed value");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await keyOf(secret), unb64(ct));
  return JSON.parse(new TextDecoder().decode(plain));
}
