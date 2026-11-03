// On a disposable CI runner only. Test accounts only: synthetic names at omb-test.example.
import { createHash, createHmac, randomBytes } from "node:crypto";
export async function signedPost(cloud, path, body) {
  const text = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const bodyHash = createHash("sha256").update(text).digest("base64url");
  const signature = createHmac("sha256", cloud.secret).update(`v1\n${timestamp}\n${nonce}\nPOST\n${path}\n${bodyHash}`).digest("base64url");
  const host = new URL(cloud.origin).host;
  return fetch(`http://127.0.0.1:${cloud.port}${path}`, { method: "POST", headers: { host, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: cloud.origin, "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${signature}` }, body: text });
}
export async function mintPairing(cloud, label, extra = {}) {
  const answer = await signedPost(cloud, "/api/cloud/pairing", { label, ttlSeconds: 300, ...extra });
  const parsed = await answer.json();
  if (!parsed.code) throw new Error(`pairing refused: ${answer.status} ${JSON.stringify(parsed).slice(0, 200)}`);
  return parsed;
}
export const edge = (cloud) => ({ host: new URL(cloud.origin).host, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: cloud.origin });
export async function api(cloud, token, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${cloud.port}${path}`, { method, headers: { ...edge(cloud), "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); let parsed = null; try { parsed = JSON.parse(text); } catch {}
  return { status: response.status, body: parsed, text };
}
export async function tokenFor(cloud, email, role) {
  const grant = await mintPairing(cloud, "OpenMausBot app (Team Cloud)", cloud.teamId ? { team: { id: cloud.teamId, name: cloud.name }, member: { email, role } } : {});
  const paired = await api(cloud, null, "POST", "/api/auth/pair", { code: grant.code, label: "fixture" });
  if (!paired.body?.token) throw new Error(`pair failed ${paired.status} ${paired.text.slice(0, 200)}`);
  return paired.body.token;
}
