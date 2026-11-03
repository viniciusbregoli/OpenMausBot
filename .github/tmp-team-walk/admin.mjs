// On a disposable CI runner only: a fake MausBot Admin and a TLS front for real Cloud-mode servers on this machine. Its answers are
// sessions captured from the real Admin over fakes, with synthetic accounts. /etc/hosts points every name here; nothing reaches a real service.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";
import { mintPairing } from "./lib.mjs";
const dir = process.argv[2];
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const ADMIN_HOSTS = new Set(["cloud.openmausbot.com", "omb-cloud-staging.fly.dev", "cloud.mausbot.com", "platform.mausbot.com"]), CODE = "12345678", ATTEMPT = "a".repeat(43), DAY = 86400_000;
const control = () => { try { return JSON.parse(readFileSync(join(dir, "control.json"), "utf8")); } catch { return {}; } };
const log = (entry) => appendFileSync(join(dir, "admin.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
const short = (token) => (token ? createHash("sha256").update(token).digest("hex").slice(0, 10) : null);
const tokens = new Map(), revoked = new Set();
let pending = null, serial = 0;
const accountOf = (email) => Object.values(scenario.accounts).find((account) => account.email === email) ?? null;
function sessionBody(entry) {
  const { account, deviceId } = entry, c = control();
  let session = c.held && account.heldSession ? account.heldSession : account.session;
  session = JSON.parse(JSON.stringify(session));
  if (c.removed && account.role === "member") { delete session.teams; session.clouds = []; }
  if (c.emptyList) session.clouds = [];
  return { ...session, device: { id: deviceId }, account: { id: account.id, email: account.email }, expiresAt: Date.now() + 30 * DAY };
}
const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
function relay(req, res, path, text) {
  if (path.endsWith("/models")) return send(res, 200, { object: "list", data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }, { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" }] });
  if (path.endsWith("/chat/completions")) {
    const input = JSON.parse(text || "{}");
    if (control().creditGone) return send(res, 402, { error: { code: "trial_credit_used_up", type: "insufficient_quota", message: "Your trial's Claude credit is used up.", param: null } });
    const words = "This is the fixture's reply through the trial credit relay.";
    if (input.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: words } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\n`);
      return void res.end("data: [DONE]\n\n");
    }
    return send(res, 200, { id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: words }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  }
  return send(res, 404, { error: { code: "not_found" } });
}
async function admin(req, res, text) {
  const url = new URL(req.url, "https://cloud.openmausbot.com"), path = url.pathname;
  const token = req.headers.authorization?.replace("Bearer ", ""), entry = token && !revoked.has(token) ? tokens.get(token) : null;
  log({ side: "admin", method: req.method, path, token: short(token), account: entry?.account.id ?? null, body: path.includes("checkout") || path.includes("clouds") ? text.slice(0, 300) : undefined });
  if (path.startsWith("/api/cloud/services/ai/")) return relay(req, res, path, text);
  if (path === "/api/public/config") return send(res, 200, scenario.publicConfig);
  if (path === "/api/cloud/app/sign-in/start") {
    const email = JSON.parse(text).email; pending = { email };
    return send(res, 200, { cloudContractVersion: 1, attempt: ATTEMPT, expiresIn: 600, resendAfter: 30, signupOpen: true });
  }
  if (path === "/api/cloud/app/sign-in/verify") {
    const input = JSON.parse(text);
    if (input.code !== CODE) return send(res, 400, { error: "invalid_code" });
    const account = accountOf(pending?.email) ?? scenario.accounts.stranger, fresh = `omc_${randomBytes(32).toString("base64url")}`, deviceId = `device-${account.id}-${randomBytes(3).toString("hex")}`;
    tokens.set(fresh, { account, deviceId });
    log({ side: "admin", event: "signed-in", account: account.id, token: short(fresh) });
    return send(res, 200, { cloudContractVersion: 1, accessToken: fresh, expiresAt: Date.now() + 30 * DAY, device: { id: deviceId }, account: { id: account.id, email: account.email } });
  }
  if (!path.startsWith("/api/cloud/desktop/")) { log({ side: "admin", unknown: path }); return send(res, 404, { error: "not_found" }); }
  const route = path.slice("/api/cloud/desktop/".length);
  if (route === "authorize") { log({ side: "admin", event: "BROWSER_APPROVAL_STARTED", body: text.slice(0, 160) }); return send(res, 200, { deviceCode: "d".repeat(43), userCode: "ABCDE-FGHJK", verificationUri: "https://cloud.openmausbot.com/cloud/desktop?code=ABCDE-FGHJK", verificationUriComplete: "https://cloud.openmausbot.com/cloud/desktop?code=ABCDE-FGHJK", expiresIn: 600, interval: 5, cloudContractVersion: 1 }); }
  if (route === "token") return send(res, 400, { error: "authorization_pending" });
  if (!entry) return send(res, 401, { error: "invalid_token" });
  if (route === "session" && req.method === "DELETE") { revoked.add(token); return send(res, 200, { ok: true }); }
  if (route === "session") return send(res, 200, sessionBody(entry));
  if (route === "checkout") { log({ side: "admin", event: "CHECKOUT_OPENED", account: entry.account.email, body: text.slice(0, 200) }); return send(res, 200, { url: `https://checkout.dodopayments.com/session/cks_fixture${++serial}` }); }
  if (route === "pairing") {
    const home = entry.account.clouds.map((id) => scenario.clouds[id]).find((cloud) => cloud.primary);
    if (!home) return send(res, 404, { error: "not_found" });
    const grant = await mintPairing(home, "OpenMausBot app");
    return send(res, 200, { cloudContractVersion: 1, origin: home.origin, code: grant.code, credential: grant.credential, expiresAt: Date.now() + 240_000 });
  }
  if (route.startsWith("teams/") && route.endsWith("/pairing")) {
    const id = route.split("/")[1], cloud = entry.account.clouds.map((key) => scenario.clouds[key]).find((candidate) => candidate.teamId === id), c = control();
    if (!cloud || (c.removed && entry.account.role === "member")) return send(res, 404, { error: "not_found" });
    if (c.held) return send(res, 409, { error: "cloud_unavailable" });
    const grant = await mintPairing(cloud, "OpenMausBot app (Team Cloud)", { team: { id, name: cloud.name }, member: { email: entry.account.email, role: entry.account.role } });
    return send(res, 200, { cloudContractVersion: 1, origin: cloud.origin, code: grant.code, credential: grant.credential, expiresAt: Date.now() + 240_000 });
  }
  log({ side: "admin", unknown: route, method: req.method });
  return send(res, 404, { error: "not_found" });
}
function front(req, res, cloud, body) {
  const forward = httpRequest({ host: "127.0.0.1", port: cloud.port, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } }, (answer) => { res.writeHead(answer.statusCode, answer.headers); answer.pipe(res); });
  forward.on("error", () => { res.writeHead(502); res.end(); });
  forward.end(body);
}
const cloudOfHost = (host) => Object.values(scenario.clouds).find((candidate) => new URL(candidate.origin).hostname === host);
const server = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks), host = (req.headers.host ?? "").split(":")[0];
    if (host === "cloud.openmausbot.com" && (req.url ?? "").startsWith("/cloud")) { res.writeHead(200, { "content-type": "text/html" }); return void res.end("<h1>Fixture page standing in for the Cloud page</h1>"); }
    if (host === "checkout.dodopayments.com") { res.writeHead(200, { "content-type": "text/html" }); return void res.end("<h1>Fixture page standing in for the payment page</h1>"); }
    if (ADMIN_HOSTS.has(host)) return void admin(req, res, body.toString("utf8")).catch((error) => { log({ side: "admin", error: String(error?.message ?? error).slice(0, 200) }); send(res, 500, { error: "fixture" }); });
    const cloud = cloudOfHost(host);
    if (!cloud) { log({ side: "unknown-host", host }); res.writeHead(421); return void res.end(); }
    front(req, res, cloud, body);
  });
});
server.on("upgrade", (req, socket, head) => {
  const host = (req.headers.host ?? "").split(":")[0], cloud = cloudOfHost(host);
  if (!cloud) return void socket.destroy();
  const forward = httpRequest({ host: "127.0.0.1", port: cloud.port, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } });
  forward.on("upgrade", (answer, upstream, upstreamHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(answer.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
    upstream.write(head); socket.write(upstreamHead); upstream.pipe(socket); socket.pipe(upstream);
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
  });
  forward.on("error", () => socket.destroy()); forward.end();
});
server.listen(Number(process.env.FIXTURE_PORT ?? 443), "0.0.0.0", () => log({ side: "fixture", event: "listening" }));
