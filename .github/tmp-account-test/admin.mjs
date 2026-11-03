// On a disposable CI runner only: a fake MausBot Admin and a TLS front for real Cloud-mode servers on this machine. Test
// accounts only. /etc/hosts on the runner points the Admin's name and the Clouds' names here, so nothing reaches a real service.
// Usage: node admin.mjs <dir with key.pem, cert.pem, scenario.json, log file admin.jsonl>
import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";

const dir = process.argv[2];
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const ADMIN_HOST = "cloud.openmausbot.com", CODE = "12345678", ATTEMPT = "a".repeat(43), DAY = 86400_000;
const log = (entry) => appendFileSync(join(dir, "admin.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
const short = (token) => (token ? createHash("sha256").update(token).digest("hex").slice(0, 10) : null);
const tokens = new Map(), revoked = new Set();
for (const account of Object.values(scenario.accounts)) if (account.token) tokens.set(account.token, { account, deviceId: `device-${account.id}` });
let pending = null;

const accountOf = (email) => Object.values(scenario.accounts).find((account) => account.email === email) ?? null;
const cloudsOf = (account) => (account.clouds ?? []).map((id) => scenario.clouds[id]);
function sessionBody(entry) {
  const { account, deviceId } = entry, clouds = cloudsOf(account), primary = clouds.find((cloud) => cloud.primary) ?? null;
  return { cloudContractVersion: 1, expiresAt: entry.expiresAt ?? Date.now() + 30 * DAY, device: { id: deviceId }, account: { id: account.id, email: account.email },
    entitlement: account.plan === "free" ? { plan: "free", status: "inactive", expiresAt: null, version: 1 } : { plan: "pro", tier: "pro", status: "active", expiresAt: Date.now() + 30 * DAY, version: 1 },
    cloud: primary ? { state: "ready", origin: primary.origin, ...(existsSync(join(dir, "moves-on")) ? { moves: true } : {}) } : null,
    clouds: clouds.map((cloud) => ({ id: cloud.id, name: cloud.name, color: cloud.color ?? null, role: cloud.role ?? "owner", tier: "pro", runsOn: "cloud", status: cloud.status ?? "ready", origin: cloud.origin ?? null, teamId: cloud.teamId ?? null, primary: cloud.primary === true, ...(cloud.removable ? { removable: true } : {}), ...(cloud.deleteAfter ? { deleteAfter: cloud.deleteAfter } : {}), ...(cloud.setup ? { setup: cloud.setup } : {}) })),
    teams: clouds.filter((cloud) => cloud.teamId).map((cloud) => ({ id: cloud.teamId, name: cloud.name, role: "member", machine: { state: "ready", origin: cloud.origin } })) };
}
async function mintPairing(cloud, label, extra = {}) {
  const body = JSON.stringify({ label, ttlSeconds: 300, ...extra });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const bodyHash = createHash("sha256").update(body).digest("base64url");
  const signature = createHmac("sha256", cloud.secret).update(`v1\n${timestamp}\n${nonce}\nPOST\n/api/cloud/pairing\n${bodyHash}`).digest("base64url");
  const host = new URL(cloud.origin).host;
  const answer = await fetch(`http://127.0.0.1:${cloud.port}/api/cloud/pairing`, { method: "POST", headers: { host, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: cloud.origin,
    "content-type": "application/json", "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${signature}` }, body });
  const parsed = await answer.json();
  if (!parsed.code) throw new Error(`pairing refused: ${answer.status} ${JSON.stringify(parsed).slice(0, 200)}`);
  return { cloudContractVersion: 1, origin: cloud.origin, code: parsed.code, expiresAt: Date.now() + 240_000 };
}
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
async function admin(req, res, text) {
  const url = new URL(req.url, `https://${ADMIN_HOST}`), path = url.pathname;
  const token = req.headers.authorization?.replace("Bearer ", "");
  const entry = token && !revoked.has(token) ? tokens.get(token) : null;
  log({ side: "admin", method: req.method, path, token: short(token), account: entry?.account.id ?? null });
  if (path === "/api/public/config") return send(res, 200, { capabilities: {} });
  if (path === "/api/cloud/app/sign-in/start") {
    const email = JSON.parse(text).email;
    pending = { email };
    return accountOf(email) ? send(res, 200, { cloudContractVersion: 1, attempt: ATTEMPT, expiresIn: 600, resendAfter: 30, signupOpen: true }) : send(res, 403, { error: "signup_closed" });
  }
  if (path === "/api/cloud/app/sign-in/verify") {
    const input = JSON.parse(text);
    if (input.code !== CODE) return send(res, 400, { error: "invalid_code" });
    const account = accountOf(pending?.email), fresh = `omc_${randomBytes(32).toString("base64url")}`, deviceId = `device-${account.id}-${randomBytes(3).toString("hex")}`;
    const expiresAt = account.shortSeconds ? Date.now() + account.shortSeconds * 1000 : Date.now() + 30 * DAY;
    tokens.set(fresh, { account, deviceId, ...(account.shortSeconds ? { expiresAt } : {}) });
    log({ side: "admin", event: "signed-in", account: account.id, token: short(fresh) });
    return send(res, 200, { cloudContractVersion: 1, accessToken: fresh, expiresAt, device: { id: deviceId }, account: { id: account.id, email: account.email } });
  }
  if (!path.startsWith("/api/cloud/desktop/")) return send(res, 404, { error: "not_found" });
  const route = path.slice("/api/cloud/desktop/".length);
  if (route === "authorize" || route === "token") return send(res, 404, { error: "not_found" });
  if (!entry) return send(res, 401, { error: "invalid_token" });
  if (route === "session" && req.method === "DELETE") { revoked.add(token); log({ side: "admin", event: "revoked", account: entry.account.id, token: short(token) }); return send(res, 200, { ok: true }); }
  if (route === "session") return send(res, 200, sessionBody(entry));
  if (route.startsWith("clouds/") && route.endsWith("/hide")) {
    const id = route.split("/")[1], at = (entry.account.clouds ?? []).indexOf(id);
    log({ side: "admin", event: "hide", cloud: id, account: entry.account.id });
    if (at < 0) return send(res, 404, { error: "not_found" });
    entry.account.clouds.splice(at, 1);
    return send(res, 200, { cloudContractVersion: 1, ok: true });
  }
  if (route === "pairing") {
    const asked = text ? JSON.parse(text).cloudId : null, clouds = cloudsOf(entry.account);
    const cloud = asked ? clouds.find((candidate) => candidate.id === asked) : clouds.find((candidate) => candidate.primary);
    if (!cloud) return send(res, 404, { error: "not_found" });
    return send(res, 200, await mintPairing(cloud, "OpenMausBot app"));
  }
  if (route.startsWith("teams/") && route.endsWith("/pairing")) {
    const id = route.split("/")[1], cloud = cloudsOf(entry.account).find((candidate) => candidate.teamId === id);
    if (!cloud) return send(res, 404, { error: "not_found" });
    return send(res, 200, await mintPairing(cloud, "OpenMausBot app (Team Cloud)", { team: { id, name: cloud.name }, member: { email: entry.account.email, role: "member" } }));
  }
  return send(res, 404, { error: "not_found" });
}
function front(req, res, cloud, body) {
  const hasCookie = /(^|;\s*)[^=]+=/.test(req.headers.cookie ?? "");
  if (!/\.(js|css|woff2?|png|svg|map)$/.test(req.url)) log({ side: "cloud", cloud: cloud.id, method: req.method, path: req.url.split("?")[0], cookie: hasCookie, status: undefined });
  const forward = httpRequest({ host: "127.0.0.1", port: cloud.port, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } }, (answer) => {
    res.writeHead(answer.statusCode, answer.headers); answer.pipe(res);
  });
  forward.on("error", () => { res.writeHead(502); res.end(); });
  forward.end(body);
}
const server = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks), host = (req.headers.host ?? "").split(":")[0];
    if (host === ADMIN_HOST) return void admin(req, res, body.toString("utf8")).catch((error) => { log({ side: "admin", error: String(error?.message ?? error).slice(0, 200) }); send(res, 500, { error: "fixture" }); });
    const cloud = Object.values(scenario.clouds).find((candidate) => new URL(candidate.origin).hostname === host);
    if (!cloud) { log({ side: "unknown-host", host }); res.writeHead(421); return void res.end(); }
    front(req, res, cloud, body);
  });
});
server.on("upgrade", (req, socket, head) => {
  const host = (req.headers.host ?? "").split(":")[0], cloud = Object.values(scenario.clouds).find((candidate) => new URL(candidate.origin).hostname === host);
  if (!cloud) return void socket.destroy();
  const forward = httpRequest({ host: "127.0.0.1", port: cloud.port, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } });
  forward.on("upgrade", (answer, upstream, upstreamHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(answer.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
    upstream.write(head); socket.write(upstreamHead); upstream.pipe(socket); socket.pipe(upstream);
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
  });
  forward.on("error", () => socket.destroy());
  forward.end();
});
server.listen(Number(process.env.FIXTURE_PORT ?? 443), "0.0.0.0", () => log({ side: "fixture", event: "listening" }));
