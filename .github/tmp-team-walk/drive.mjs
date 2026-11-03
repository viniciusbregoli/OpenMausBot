// On a disposable CI runner only: walks the real packaged app, as a first-time person would, against the fake Admin.
// Every step takes a screenshot (the app's page, and the whole screen) and writes what the page says as text.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { api, signedPost, tokenFor } from "./lib.mjs";

const OUT = process.env.OUT, F = join(process.env.RUNNER_TEMP, "fx"), BIN = join(process.env.APP_DIR, "OpenMausBot.app/Contents/MacOS/OpenMausBot");
const CDP = "http://127.0.0.1:9222", LOCAL = "http://127.0.0.1:8799", CODE = "12345678", HOME = process.env.HOME;
const scenario = JSON.parse(readFileSync(join(F, "scenario.json"), "utf8"));
const EMAIL = Object.fromEntries(Object.entries(scenario.accounts).map(([key, account]) => [key, account.email]));
const CLOUD = scenario.clouds;
mkdirSync(join(OUT, "shots"), { recursive: true }); mkdirSync(join(OUT, "text"), { recursive: true });
const results = [];
let shotCount = 0, proc = null, launches = 0;
const save = () => writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
function note(name, ok, detail = "") { results.push({ name, ok: Boolean(ok), detail: typeof detail === "string" ? detail.slice(0, 1200) : JSON.stringify(detail).slice(0, 1200) }); console.log(`${ok ? "OK  " : "NOTE"}  ${name}  ${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 240)}`); save(); }
const until = async (work, what, ms = 30_000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await work(); if (last) return last; } catch (error) { last = error; } await delay(400); } throw new Error(`timed out: ${what}: ${String(last?.message ?? last ?? "").slice(0, 200)}`); };
const targets = async () => (await fetch(`${CDP}/json/list`)).json();
class Page {
  constructor(target) { this.target = target; this.id = 0; this.wait = new Map(); }
  async open() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error("no socket")); });
    this.ws.onmessage = (event) => { const message = JSON.parse(event.data); const done = this.wait.get(message.id); if (done) { this.wait.delete(message.id); message.error ? done.reject(new Error(message.error.message)) : done.resolve(message.result); } };
    return this;
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.wait.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.wait.delete(id)) reject(new Error(`${method} timed out`)); }, 20_000); }); }
  async eval(expression) {
    const answer = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: false });
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
    return answer.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}
const pageUrl = /^(http:\/\/127\.0\.0\.1:8799|https:\/\/[a-z0-9-]+\.omb-test\.example)/;
const isMain = (target) => target.type === "page" && pageUrl.test(target.url) && !new URL(target.url).pathname.startsWith("/rail");
const isRail = (target) => target.url.includes("/rail");
const main = async () => {
  const candidates = await until(async () => { const found = (await targets()).filter(isMain); return found.length ? found : null; }, "the main window's page", 15_000);
  for (const target of candidates) { const page = await new Page(target).open(); const visible = await page.eval("document.visibilityState === 'visible'").catch(() => false); if (visible || candidates.length === 1) return page; page.close(); }
  return new Page(candidates[0]).open();
};
const rail = async () => { const target = (await targets()).find(isRail); return target ? new Page(target).open() : null; };
async function within(open, work) { const page = await open(); if (!page) return null; try { return await work(page); } finally { page.close(); } }
const TEXT = `(() => { const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog],[data-cloud-add-dialog]')].map((el) => el.innerText); return JSON.stringify({ url: location.href, title: document.title, dialogs, body: document.body?.innerText ?? "" }); })()`;
async function shot(name) {
  const label = `${String(++shotCount).padStart(3, "0")}-${name}`;
  try { await within(main, async (page) => {
    const { data } = await page.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(OUT, "shots", `${label}.png`), Buffer.from(data, "base64"));
    const said = JSON.parse(await page.eval(TEXT)); const railSaid = await within(rail, (r) => r.eval(`[...document.querySelectorAll("[data-rail-place],[data-rail-add]")].map((el) => el.getAttribute("aria-label"))`)).catch(() => null);
    writeFileSync(join(OUT, "text", `${label}.txt`), `URL: ${said.url}\nTITLE: ${said.title}\nRAIL: ${JSON.stringify(railSaid)}\nDIALOGS: ${JSON.stringify(said.dialogs, null, 1)}\n----\n${said.body}\n`);
  }); } catch (error) { console.log(`no page shot ${label}: ${error.message}`); }
  try { execFileSync("screencapture", ["-x", join(OUT, "shots", `${label}-screen.png`)], { timeout: 15_000 }); } catch {}
  console.log(`shot ${label}`);
}
async function clickExpr(page, expression, { button = "left" } = {}) {
  const read = () => page.eval(`(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  let box = await read();
  if (!box) return false;
  for (let tries = 0; tries < 20; tries++) { await delay(100); const next = await read(); if (!next) return false; const still = Math.abs(next.x - box.x) < 1 && Math.abs(next.y - box.y) < 1; box = next; if (still) break; }
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await delay(150);
  for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button, clickCount: 1 });
  return true;
}
const byText = (pattern, within_ = "document", roles = "button,a,[role^=menuitem],[role=option],[role=tab],summary,label") => `[...${within_}.querySelectorAll(${JSON.stringify(roles)})].filter((el) => el.offsetParent !== null || el.getClientRects().length).find((el) => ${pattern}.test((el.innerText || el.getAttribute("aria-label") || "").trim()))`;
const click = (pattern, options) => within(main, (page) => clickExpr(page, byText(pattern), options));
const clickSel = (selector, options) => within(main, (page) => clickExpr(page, `document.querySelector(${JSON.stringify(selector)})`, options));
const QUIET = `try { localStorage.setItem("omb-analytics-opt-out", "1"); localStorage.setItem("omb-email-gate", "skipped"); localStorage.setItem("omb-advanced-mode", "0"); } catch {}`;
async function launch({ quiet = true } = {}) {
  const log = join(OUT, `app-${++launches}.log`); writeFileSync(log, "");
  const trust = readFileSync(join(OUT, "trust.txt"), "utf8");
  proc = spawn(BIN, ["--remote-debugging-port=9222", ...(/successful/i.test(trust) ? [] : ["--ignore-certificate-errors"])], { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(F, "ca.pem"), NODE_USE_SYSTEM_CA: "1", ELECTRON_ENABLE_LOGGING: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [proc.stdout, proc.stderr]) stream.on("data", (chunk) => appendFileSync(log, chunk));
  await until(async () => (await targets()).some((target) => target.type === "page" && isMain(target)), "the app's main page", 90_000);
  if (quiet) { await within(main, (page) => page.send("Page.addScriptToEvaluateOnNewDocument", { source: QUIET })); await within(main, (page) => page.eval(QUIET)); }
  await delay(4000);
}
async function quit() {
  if (!proc) return;
  const pid = proc.pid, gone = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  process.kill(pid, "SIGTERM");
  const ended = await Promise.race([gone, delay(30_000).then(() => null)]);
  if (!ended) { process.kill(pid, "SIGKILL"); await gone; }
  await until(async () => { try { await fetch(`${LOCAL}/api/health`, { signal: AbortSignal.timeout(800) }); return false; } catch { return true; } }, "port 8799 closing", 20_000).catch(() => {});
  await delay(1500);
}
const reset = () => { // Back to a computer that has used the app for a while and never signed in.
  for (const dir of [join(HOME, "Library/Application Support/openmausbot"), join(HOME, "Library/Application Support/OpenMausBot"), join(HOME, "Library/Application Support/MausBot"), join(HOME, ".openmausbot")]) rmSync(dir, { recursive: true, force: true });
};
const seed = (profile) => {
  mkdirSync(join(HOME, ".openmausbot"), { recursive: true });
  writeFileSync(join(HOME, ".openmausbot/config.json"), JSON.stringify({ language: "en", ...(profile ? { profile } : {}), onboarding: { completedAt: "2026-11-01T00:00:00.000Z", version: 1, hintsSeen: ["spot.composer", "spot.model", "spot.approval", "spot.connector", "tour.composer", "tour.model", "tour.computer", "tour.computer-browser", "tour.tools", "tour.apps"] } }));
};
const control = (value) => writeFileSync(join(F, "control.json"), JSON.stringify(value));
const adminLog = () => { try { return readFileSync(join(F, "admin.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)); } catch { return []; } };
const railPlaces = async () => (await within(rail, (page) => page.eval(`[...document.querySelectorAll("[data-rail-place]")].map((el) => el.getAttribute("aria-label"))`)).catch(() => null)) ?? [];
const clickTile = (name) => within(rail, (page) => clickExpr(page, `[...document.querySelectorAll("[data-rail-place]")].find((el) => (el.getAttribute("aria-label") || "").includes(${JSON.stringify(name)}))`));
async function openYou() {
  const opened = await within(main, (page) => clickExpr(page, `(document.querySelector("[data-sidebar-account]")?.closest("button") || [...document.querySelectorAll("button[aria-haspopup=menu]")].at(-1))`));
  if (!opened) throw new Error("no You menu");
  return until(() => within(main, async (page) => { const rows = await page.eval(`[...document.querySelectorAll('[role^="menuitem"]')].map((el) => (el.textContent || "").trim())`); return rows.length ? rows : null; }), "the You menu's rows");
}
const escape = () => within(main, async (page) => { await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await delay(400); });
const openSettings = async () => { const rows = await openYou(); await click(/^Settings$/); await delay(1200); return rows; };
const typeInto = (selector, text) => within(main, async (page) => { await page.eval(`document.querySelector(${JSON.stringify(selector)})?.focus()`); await page.send("Input.insertText", { text }); await delay(200); });
const enter = () => within(main, async (page) => { for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: type === "keyDown" ? "\r" : undefined }); });
const dialogsOpen = () => within(main, (page) => page.eval(`[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].map((el) => (el.innerText || "").slice(0, 200))`));
/** Whatever popped up by itself: seen first (it is part of what a person sees), then closed the way a person would close it. */
async function popups(label) {
  for (let i = 0; i < 4; i++) {
    const open = await dialogsOpen().catch(() => []);
    if (!open?.length) return;
    await shot(`popup-${label}-${i}`);
    note(`popup over ${label}`, true, open);
    const closed = await within(main, (page) => clickExpr(page, `[...document.querySelectorAll('[role=dialog] button,[role=alertdialog] button')].find((el) => /^(not now|close|maybe later|no thanks|skip|got it|dismiss|later|continue|ok|set up later)$/i.test((el.innerText || el.getAttribute("aria-label") || "").trim()))`));
    if (!closed) { await escape(); }
    await delay(800);
  }
}
async function signInBySheet(email) {
  // The route an invited person has today: the plan page's "Sign in to your Cloud plan".
  await openSettings();
  await click(/^Usage & billing$|^Usage and billing$|^Plan$/).catch(() => {}); await delay(800);
  await shot("settings-plan-page");
  const asked = await click(/^Sign in to your Cloud plan$/);
  if (!asked) throw new Error("no 'Sign in to your Cloud plan'");
  await delay(1000);
  await shot("sign-in-sheet");
  await within(main, async (page) => { await page.eval(`(() => { const el = document.querySelector('[data-cloud-add-dialog] input[type=email], [data-cloud-add-dialog] input'); el?.focus(); el?.select?.(); })()`); await page.send("Input.insertText", { text: email }); });
  await delay(300);
  await click(/^Send code$/); await delay(1200);
  await shot("sign-in-code");
  await within(main, async (page) => { await page.eval(`document.querySelector('[data-cloud-add-dialog] input')?.focus()`); await page.send("Input.insertText", { text: CODE }); });
  await delay(2500);
}
const signOutApi = () => within(main, async (page) => { const view = await page.eval("window.ogb.accounts?.list?.()"); if (view?.active) await page.eval(`window.ogb.accounts.signOut(${JSON.stringify(view.active.id)})`); });
async function step(name, work) { console.log(`\n=== ${name}`); try { await work(); } catch (error) { note(`${name}: stopped`, false, String(error?.message ?? error)); await shot(`failed-${name.replace(/\W+/g, "-").slice(0, 40)}`).catch(() => {}); } }
const fresh = async (profile) => { await quit(); reset(); seed(profile); control({}); await launch(); };

const STAGE = new Set((process.env.STAGES ?? "fresh,signedout,trialbutton,member,levels,stranger,ownercode,studiosui,ownertrial,move,held,removed").split(","));
// ---------------------------------------------------------------- a new install: the invited person downloads the app
if (STAGE.has("fresh")) await step("new install, first launch", async () => {
  reset(); control({}); await launch({ quiet: false });
  await shot("fresh-1-first-screen");
  for (let i = 2; i < 7; i++) {
    const before = await within(main, (page) => page.eval("document.body.innerText.slice(0,300)"));
    const moved = await within(main, (page) => clickExpr(page, `[...document.querySelectorAll("button,a")].filter((el) => el.getClientRects().length).find((el) => /^(continue|set up later|skip|skip for now|next|get started|not now|maybe later)$/i.test((el.innerText || "").trim()))`));
    if (!moved) break;
    await delay(1800);
    const after = await within(main, (page) => page.eval("document.body.innerText.slice(0,300)"));
    await shot(`fresh-${i}`);
    if (before === after) break;
  }
  note("new install: anything about a team or an invitation on screen?", true, await within(main, (page) => page.eval(`/invit|team/i.test(document.body.innerText) ? document.body.innerText.slice(0, 600) : "no mention"`)));
});
// ---------------------------------------------------------------- already installed, signed out (the customer's "I don't see anything")
if (STAGE.has("signedout")) await step("installed app, never signed in, has accepted an invitation in a browser", async () => {
  await fresh({ name: "Dana Second", email: EMAIL.member });
  await shot("out-1-what-they-see"); await popups("out-1");
  await shot("out-2-after-popups");
  note("signed out: the rail's places", true, await railPlaces());
  const rows = await openYou(); note("signed out: You menu rows", true, rows); await shot("out-3-you-menu"); await escape();
  await openSettings(); await shot("out-4-settings-general-account");
  note("settings first page says", true, await within(main, (page) => page.eval(`document.querySelector('[role=dialog]')?.innerText?.slice(0, 900) ?? document.body.innerText.slice(0, 900)`)));
  await click(/^Usage & billing$|^Usage and billing$/); await delay(1000); await shot("out-5-settings-usage-billing"); await escape(); await escape();
  const header = await within(main, (page) => clickExpr(page, byText(/^This computer$/)));
  note("signed out: a 'This computer' switcher to press", Boolean(header)); await delay(500); await shot("out-6-switcher-open"); await escape();
});
// ---------------------------------------------------------------- what if the teammate presses the big button?
if (STAGE.has("trialbutton")) await step("the teammate presses Start free trial", async () => {
  await fresh({ name: "Dana Second", email: EMAIL.member }); await popups("trial");
  await openSettings(); await shot("trial-1-account-row");
  const pressed = await click(/^Start free trial$/);
  note("Start free trial was there to press", Boolean(pressed)); await delay(1500); await shot("trial-2-plans");
  note("plans sheet says", true, await within(main, (page) => page.eval(`document.querySelector('[data-cloud-add-dialog]')?.innerText ?? ""`)));
  const team = await clickSel('[data-plan-buy="team"]'); note("Team's own button on the plans", Boolean(team)); await delay(1200); await shot("trial-3-after-get-team");
  note("next screen says", true, await within(main, (page) => page.eval(`document.querySelector('[data-cloud-add-dialog]')?.innerText ?? ""`)));
  await click(/^Send code$/); await delay(1500); await shot("trial-4-code");
  await within(main, async (page) => { await page.eval(`document.querySelector('[data-cloud-add-dialog] input')?.focus()`); await page.send("Input.insertText", { text: CODE }); });
  await delay(4000); await shot("trial-5-after-the-code");
  note("after the code, the sheet says", true, await within(main, (page) => page.eval(`document.querySelector('[data-cloud-add-dialog]')?.innerText ?? "(no sheet)"`)));
  note("checkouts the app asked the Admin to open, for this person", true, adminLog().filter((row) => row.event === "CHECKOUT_OPENED"));
  note("the rail after signing in", true, await railPlaces());
  await delay(1500); await shot("trial-6-a-moment-later");
});
// ---------------------------------------------------------------- the invited person signs in as the Plan page offers
if (STAGE.has("member")) await step("the invited person signs in", async () => {
  await fresh({ name: "Dana Second", email: EMAIL.member }); await popups("member");
  await signInBySheet(EMAIL.member);
  await shot("member-1-just-signed-in"); note("member signed in: the rail", true, await railPlaces());
  note("member: is the window on the team by itself?", true, (await targets()).filter(isMain).map((t) => t.url));
  note("member: sheet still open?", true, await within(main, (page) => page.eval(`document.querySelector('[data-cloud-add-dialog]')?.innerText ?? "(no sheet)"`)));
  await escape(); await escape(); await delay(800); await shot("member-2-closed-sheet");
  const rows = await openYou(); note("member on this computer: You menu", true, rows); await escape();
  await clickTile("Acme"); await delay(6000);
  await shot("member-3-first-open-of-the-team"); await popups("member-team");
  await shot("member-4-team-no-bots-shared");
  note("member's bots with nothing shared", true, await within(main, (page) => page.eval(`[...document.querySelectorAll("[data-sidebar-bot-row]")].map((el) => el.innerText.slice(0, 60))`)));
  // Says something to their own MausBot with no AI on the Team Cloud.
  await typeInto("textarea", "Hi, what can you do for me?"); await enter(); await delay(6000); await shot("member-5-first-message-no-ai");
  const you = await openYou(); note("member on the team: You menu", true, you); await shot("member-6-you-menu-on-team"); await escape();
  await openSettings(); await shot("member-7-settings-on-team"); note("member settings says", true, await within(main, (page) => page.eval(`document.querySelector('[role=dialog]')?.innerText?.slice(0, 1200) ?? ""`))); await escape(); await escape();
});
// ---------------------------------------------------------------- after joining: a shared bot at each level
if (STAGE.has("levels")) await step("the owner shares bots at each level", async () => {
  const cloud = CLOUD.team, owner = await tokenFor(cloud, EMAIL.ownerCode, "owner");
  const make = async (name, access) => { const made = await api(cloud, owner, "POST", "/api/bots", { name, title: `${name} desk` }); note(`owner made ${name}`, made.status < 300, made.status === 201 || made.status === 200 ? "" : made.text.slice(0, 200)); if (access) { const set = await api(cloud, owner, "PUT", `/api/bots/${made.body.id ?? made.body.bot?.id}/access`, access); note(`access for ${name}`, set.status < 300, set.status < 300 ? access : set.text.slice(0, 200)); } return made.body; };
  await make("Scout");                                                                   // left as it is made: the default
  await make("Payroll", { everyone: "none", people: { [EMAIL.member]: "view" } });
  await make("Finance", { everyone: "none", people: { [EMAIL.member]: "chat" } });
  await make("Editor", { everyone: "none", people: { [EMAIL.member]: "edit" } });
  await make("Secret", { everyone: "none", people: {} });
  await delay(3000); await shot("levels-1-sidebar-as-member");
  const rows = await within(main, (page) => page.eval(`[...document.querySelectorAll("[data-sidebar-bot-row]")].map((el) => el.innerText.split("\\n")[0])`));
  note("member's bot list", true, rows); note("member cannot see Secret", !rows.includes("Secret"), rows); note("member sees Scout without anyone sharing it (a new bot is shared)", rows.includes("Scout"), rows);
  for (const name of ["Scout", "Payroll", "Finance", "Editor"]) {
    await within(main, (page) => clickExpr(page, `[...document.querySelectorAll("[data-sidebar-bot-row]")].find((el) => el.innerText.startsWith(${JSON.stringify(name)}))`)); await delay(1800);
    await shot(`levels-2-${name.toLowerCase()}`);
    note(`level: ${name}`, true, await within(main, (page) => page.eval(`({ composer: Boolean(document.querySelector("textarea")), banner: [...document.querySelectorAll("main,[role=main]")].map((el) => el.innerText.slice(-260)) })`)));
  }
  await within(main, (page) => clickExpr(page, `[...document.querySelectorAll("[data-sidebar-bot-row]")].find((el) => el.innerText.startsWith("Scout"))`)); await delay(1200);
  await typeInto("textarea", "@"); await delay(1200); await shot("levels-3-at-list");
  note("@ list", true, await within(main, (page) => page.eval(`[...document.querySelectorAll('[role=listbox] [role=option],[data-mention-option],[role=option]')].map((el) => el.innerText.replace(/\\n/g, " · "))`)));
  await within(main, (page) => page.eval(`document.querySelector("textarea")?.select?.()`)); await within(main, (page) => page.send("Input.insertText", { text: "Hello team" })); await delay(300); await enter(); await delay(3500); await shot("levels-4-shared-chat-message");
  const plus = await within(main, (page) => clickExpr(page, `document.querySelector('[aria-label="New conversation"],[aria-label*="New conversation"]')`)); note("New conversation button", Boolean(plus)); await delay(1500); await shot("levels-5-private-chat");
});
// ---------------------------------------------------------------- the invited address is not the one signed in
if (STAGE.has("stranger")) await step("the app is signed in as someone else", async () => {
  await fresh({ name: "Dana Second", email: EMAIL.stranger }); await popups("stranger");
  await signInBySheet(EMAIL.stranger); await shot("stranger-1-signed-in"); await escape(); await escape(); await delay(600);
  note("someone else: the rail", true, await railPlaces()); const rows = await openYou(); note("someone else: You menu", true, rows); await shot("stranger-2-you-menu"); await escape();
  await openSettings(); await click(/^Usage & billing$|^Usage and billing$/); await delay(800); await shot("stranger-3-plan-page"); await escape(); await escape();
});
// ---------------------------------------------------------------- owner, paid with a code: no credit, no AI
if (STAGE.has("ownercode")) await step("owner of a Team with no credit and no AI", async () => {
  await fresh({ name: "Olive Owner", email: EMAIL.ownerCode }); await popups("ownercode");
  await signInBySheet(EMAIL.ownerCode); await shot("code-1-just-signed-in"); note("owner sheet", true, await within(main, (page) => page.eval(`document.querySelector('[data-cloud-add-dialog]')?.innerText ?? "(no sheet)"`)));
  note("owner: the rail", true, await railPlaces()); note("owner: where the window is", true, (await targets()).filter(isMain).map((t) => t.url));
  const open = await click(/^Open Acme$/); note("sheet's Open Acme", Boolean(open)); if (!open) { await escape(); await escape(); await clickTile("Acme"); } await delay(7000);
  await shot("code-2-team-first-open"); await popups("code"); await shot("code-3-team-after-popups");
  note("owner on the team, no AI: screen says", true, await within(main, (page) => page.eval(`document.body.innerText.slice(0, 900)`)));
  await within(main, (page) => clickExpr(page, byText(/^Use an API key/))); await delay(1200); await shot("code-4-api-key");  await escape();
  const you = await openYou(); note("owner on the team: You menu", true, you); await escape();
  await openSettings(); await shot("code-5-settings"); await click(/^People$/).catch(() => {}); await delay(800); await shot("code-6-settings-people"); await escape(); await escape();
});

// ---------------------------------------------------------------- the two studios, by hand, with the real labels (Simple, then Advanced)
if (STAGE.has("studiosui")) await step("the owner sets up two studios by hand", async () => {
  await fresh({ name: "Olive Owner", email: EMAIL.ownerCode }); await popups("studios");
  await signInBySheet(EMAIL.ownerCode); await delay(1000);
  const open = await click(/^Open Acme$/); if (!open) { await escape(); await escape(); await clickTile("Acme"); } await delay(7000); await popups("studios-team");
  const menu = () => within(main, (page) => page.eval(`[...document.querySelectorAll('[role^="menuitem"],[data-bot-menu] button')].filter((el) => el.getClientRects().length).map((el) => (el.innerText || el.getAttribute("aria-label") || "").trim())`));
  const dialogText = () => within(main, (page) => page.eval(`[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].map((el) => el.innerText)`));
  const rowOf = (name) => `[...document.querySelectorAll("[data-sidebar-bot-row]")].find((el) => el.innerText.startsWith(${JSON.stringify(name)}))`;
  const newBot = async (name) => {
    await within(main, (page) => clickExpr(page, `document.querySelector('[aria-label="New or share"],[aria-label="New"]')`)); await delay(600);
    return { rows: await menu(), go: async () => {
      await click(/^New bot$/); await delay(1500);
      await within(main, async (page) => { await page.eval(`(() => { const el = [...document.querySelectorAll('[role=dialog] input, [data-new-bot-dialog] input')].find((x) => !x.type || x.type === "text"); el?.focus(); el?.select?.(); })()`); await page.send("Input.insertText", { text: name }); }); await delay(400);
    } };
  };
  const first = await newBot("Bookkeeping"); note("the + menu in Simple", true, first.rows); await shot("studios-1-plus-menu-simple"); await first.go(); await shot("studios-2-new-bot-dialog");
  note("New bot dialog says", true, await dialogText());
  note("the Department dropdown's choices with no department yet", true, await within(main, (page) => page.eval(`[...document.querySelectorAll('[role=dialog] select')].map((el) => [...el.options].map((o) => o.text))`)));
  await click(/^Create bot$/); await delay(3500); await shot("studios-3-bot-made"); await popups("studios-bot");
  await within(main, (page) => clickExpr(page, rowOf("Bookkeeping"), { button: "right" })); await delay(700); note("bot menu in Simple", true, await menu()); await shot("studios-4-bot-menu");
  await click(/^Move to department$/); await delay(700); note("Move to department flyout", true, await menu()); await shot("studios-5-move-to-department");
  await click(/^New department…$/); await delay(700); await shot("studios-6-new-department-field");
  await within(main, async (page) => { await page.eval(`(() => { const el = document.querySelector('input[aria-label="New department name"]') || document.activeElement; el?.focus(); })()`); await page.send("Input.insertText", { text: "Studio A" }); }); await delay(200); await enter(); await delay(1500); await shot("studios-7-department-made");
  const second = await newBot("Rooms"); await second.go(); note("the Department dropdown now", true, await within(main, (page) => page.eval(`[...document.querySelectorAll('[role=dialog] select')].map((el) => [...el.options].map((o) => o.text))`))); await shot("studios-8-second-bot"); await click(/^Create bot$/); await delay(3000); await popups("studios-bot2");
  await within(main, (page) => clickExpr(page, rowOf("Rooms"), { button: "right" })); await delay(600); await click(/^Move to department$/); await delay(600); await click(/^New department…$/); await delay(600);
  await within(main, async (page) => { await page.eval(`(() => { const el = document.querySelector('input[aria-label="New department name"]') || document.activeElement; el?.focus(); })()`); await page.send("Input.insertText", { text: "Studio B" }); }); await delay(200); await enter(); await delay(1500); await shot("studios-9-two-departments");
  // Sharing Bookkeeping: only the owner.
  const share = async (name) => { await within(main, (page) => clickExpr(page, rowOf(name))); await delay(1500); const pressed = await within(main, (page) => clickExpr(page, `document.querySelector('[aria-label="Share"]') || ${byText(/^Share$/)}`)); note(`Share button beside ${name}`, Boolean(pressed)); await delay(1000); return pressed; };
  await share("Bookkeeping"); await shot("studios-10-share-dialog"); note("Share dialog says", true, await dialogText());
  const general = await within(main, (page) => clickExpr(page, `[...document.querySelectorAll('[role=dialog] button,[role=dialog] select,[role=dialog] [role=combobox]')].find((el) => /can use it|General access/.test(el.innerText || el.getAttribute("aria-label") || ""))`)); await delay(500); await shot("studios-11-general-access-open"); note("general access control", Boolean(general), await menu());
  await within(main, (page) => clickExpr(page, `[...document.querySelectorAll('[role^="menuitem"],[role=option],[role=dialog] button')].find((el) => /^Only people added/.test((el.innerText || "").trim()))`)); await delay(1200); await shot("studios-12-only-people-added"); note("after Only people added", true, await dialogText());
  await escape(); await delay(500); await escape();
  // Sharing Rooms with a member who has accepted the invitation but never opened the app.
  await share("Rooms"); await within(main, (page) => clickExpr(page, `[...document.querySelectorAll('[role=dialog] button,[role=dialog] select,[role=dialog] [role=combobox]')].find((el) => /can use it|General access/.test(el.innerText || el.getAttribute("aria-label") || ""))`)); await delay(400); await within(main, (page) => clickExpr(page, `[...document.querySelectorAll('[role^="menuitem"],[role=option],[role=dialog] button')].find((el) => /^Only people added/.test((el.innerText || "").trim()))`)); await delay(800);
  await typeInto('[role=dialog] input', "dana2"); await delay(1000); await shot("studios-13-add-person-who-never-opened-the-app"); note("adding someone who joined but has not opened the team", true, await dialogText());
  await within(main, async (page) => { await page.eval(`(() => { const el = document.querySelector('[role=dialog] input'); el.select?.(); })()`); await page.send("Input.insertText", { text: "dana" }); }); await delay(1000); await shot("studios-14-add-person-who-opened"); note("adding someone who has opened the team", true, await dialogText());
  await within(main, (page) => clickExpr(page, `[...document.querySelectorAll('[role=dialog] [role=option],[role=dialog] button')].find((el) => /dana/i.test(el.innerText || ""))`)); await delay(1000); await shot("studios-15-added"); await escape(); await delay(500); await escape();
  // A routine by hand.
  await openYou(); await click(/^Automations$/); await delay(1800); await shot("studios-16-automations"); note("Automations page says", true, await within(main, (page) => page.eval(`document.body.innerText.slice(0, 700)`)));
  const made = await click(/^New$/); note("New on Automations", Boolean(made)); await delay(900); await shot("studios-17-new-automation"); note("New automation says", true, await dialogText());
  note("Who should do it choices", true, await within(main, (page) => page.eval(`[...document.querySelectorAll('[role=dialog] select')].map((el) => [...el.options].map((o) => o.text))`)));
  await click(/^Set it up yourself$/); await delay(900); await shot("studios-18-yourself"); note("Set it up yourself says", true, await dialogText());
  await click(/^Continue$/); await delay(1200); await shot("studios-19-schedule-form"); note("the schedule form says", true, await dialogText());
  await escape(); await delay(500); await escape();
  // Advanced's own way, and Settings' page for sharing.
  await within(main, (page) => page.eval(`localStorage.setItem("omb-advanced-mode", "1"); location.reload()`)).catch(() => {}); await delay(5000); await popups("studios-adv");
  await within(main, (page) => clickExpr(page, `document.querySelector('[aria-label="New or share"],[aria-label="New"]')`)); await delay(600); note("the + menu in Advanced", true, await menu()); await shot("studios-20-plus-menu-advanced"); await escape();
  await openSettings(); await delay(600); await shot("studios-21-settings-advanced"); note("Settings sections in Advanced", true, await dialogText());
  await click(/^Bot access$/).catch(() => {}); await delay(900); await shot("studios-22-bot-access"); await escape(); await escape();
  await within(main, (page) => page.eval(`localStorage.setItem("omb-advanced-mode", "0"); location.reload()`)).catch(() => {}); await delay(3000);
});
// ---------------------------------------------------------------- owner on a trial: the credit runs the bots
if (STAGE.has("ownertrial")) await step("owner on the trial: the credit", async () => {
  await fresh({ name: "Tess Trial", email: EMAIL.ownerTrial }); await popups("ownertrial");
  await signInBySheet(EMAIL.ownerTrial); await delay(1000); await shot("credit-1-just-signed-in");
  const open = await click(/^Open CreditCo$/); if (!open) { await escape(); await escape(); await clickTile("CreditCo"); } await delay(7000);
  await shot("credit-2-team-first-open"); await popups("credit"); await shot("credit-3-after-popups");
  await typeInto("textarea", "Say hello"); await enter(); await delay(8000); await shot("credit-4-reply");
  const owner = await tokenFor(CLOUD.credit, EMAIL.ownerTrial, "owner");
  const providers = await api(CLOUD.credit, owner, "GET", "/api/bots"); note("credit team bots' models", true, (providers.body?.bots ?? []).map((bot) => ({ name: bot.name, model: bot.modelSelection })));
  note("relay calls seen", true, adminLog().filter((row) => row.path?.includes("/services/ai/")).slice(-6).map((row) => row.path));
  // A member's turn on the credit too.
  const member = await tokenFor(CLOUD.credit, "dana-credit@omb-test.example", "member");
  const bots = await api(CLOUD.credit, member, "GET", "/api/bots"); note("a member's copy of the bots on the credit team", true, (bots.body?.bots ?? []).map((bot) => ({ name: bot.name, yourAccess: bot.yourAccess, model: bot.modelSelection })));
  control({ creditGone: true }); await typeInto("textarea", "One more"); await enter(); await delay(8000); await shot("credit-5-used-up"); control({});
});
// ---------------------------------------------------------------- owner with a My Cloud: Move to
if (STAGE.has("move")) await step("owner with a My Cloud moves a bot in", async () => {
  await fresh({ name: "Sam Both", email: EMAIL.ownerBoth }); await popups("move");
  const home = CLOUD["home-o"]; const ownerHome = await tokenFor(home, null, null).catch((error) => { note("home token", false, error.message); return null; });
  if (ownerHome) { const made = await api(home, ownerHome, "POST", "/api/bots", { name: "Atlas", title: "Atlas desk" }); note("Atlas on My Cloud", made.status < 300, made.status < 300 ? "" : made.text.slice(0, 200)); await api(home, ownerHome, "POST", "/api/bots", { name: "Beacon", title: "Beacon desk" }); }
  await signInBySheet(EMAIL.ownerBoth); await delay(1500); await shot("move-1-signed-in");
  await escape(); await escape(); note("both: the rail", true, await railPlaces());
  await clickTile("My Cloud"); await delay(7000); await shot("move-2-my-cloud"); await popups("move-home"); await shot("move-3-my-cloud-after-popups");
  const hit = await within(main, (page) => clickExpr(page, `[...document.querySelectorAll("[data-sidebar-bot-row]")].find((el) => el.innerText.startsWith("Atlas"))`, { button: "right" }));
  note("right-click on Atlas", Boolean(hit)); await delay(800); await shot("move-4-bot-menu");
  note("bot menu rows", true, await within(main, (page) => page.eval(`[...document.querySelectorAll('[role^="menuitem"],[data-menu-item]')].map((el) => (el.textContent || "").trim())`)));
  await click(/^More$/).catch(() => {}); await delay(600); await shot("move-5-bot-menu-more");
  note("More rows", true, await within(main, (page) => page.eval(`[...document.querySelectorAll('[role^="menuitem"],[data-menu-item]')].map((el) => (el.textContent || "").trim())`)));
  const move = await click(/^Move to Acme$/); note("Move to Acme", Boolean(move)); await delay(1000); await shot("move-6-confirm");
  note("confirm says", true, await within(main, (page) => page.eval(`[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].map((el) => el.innerText)`)));
  if (move) { await within(main, (page) => clickExpr(page, `[...document.querySelectorAll('[role=dialog] button,[role=alertdialog] button')].filter((el) => !/cancel|close/i.test(el.innerText)).at(-1)`)); await delay(15000); await shot("move-7-after"); note("after the move, My Cloud's list", true, await within(main, (page) => page.eval(`[...document.querySelectorAll("[data-sidebar-bot-row]")].map((el) => el.innerText.replace(/\\n/g, " · "))`))); }
  // MausBot's own menu.
  const mausbot = await within(main, (page) => clickExpr(page, `[...document.querySelectorAll("[data-sidebar-bot-row]")].find((el) => el.innerText.startsWith("MausBot"))`, { button: "right" })); if (mausbot) { await delay(500); await click(/^More$/).catch(() => {}); await delay(500); await shot("move-8-mausbot-menu"); await escape(); }
  await clickTile("Acme"); await delay(6000); await shot("move-9-team-page");
  note("the team's list after the move", true, await within(main, (page) => page.eval(`[...document.querySelectorAll("[data-sidebar-bot-row]")].map((el) => el.innerText.replace(/\\n/g, " · "))`)));
  // From the team's page, is there a way back?
  await within(main, (page) => clickExpr(page, `[...document.querySelectorAll("[data-sidebar-bot-row]")].find((el) => el.innerText.startsWith("Atlas"))`, { button: "right" })); await delay(600); await click(/^More$/).catch(() => {}); await delay(500); await shot("move-10-team-bot-menu");
  note("team bot menu rows (a way back?)", true, await within(main, (page) => page.eval(`[...document.querySelectorAll('[role^="menuitem"],[data-menu-item]')].map((el) => (el.textContent || "").trim())`))); await escape();
});
// ---------------------------------------------------------------- the team's trial failed: a member
if (STAGE.has("held")) await step("a member while the team's first payment failed", async () => {
  await fresh({ name: "Dana Second", email: EMAIL.member }); await popups("held");
  control({}); await signInBySheet(EMAIL.member); await escape(); await escape(); await delay(800);
  await clickTile("Acme"); await delay(6000); await popups("held-team"); await shot("held-1-before");
  control({ held: true }); await delay(500);
  await quit(); await launch(); await delay(3000); await shot("held-2-next-launch"); await popups("held-next");
  note("held: rail", true, await railPlaces());
  await clickTile("Acme"); await delay(5000); await shot("held-3-opening-team");
  note("held: screen says", true, await within(main, (page) => page.eval(`document.body.innerText.slice(0, 600)`)));
  const manage = await click(/^Manage in your browser$/); note("held: Manage in your browser button", Boolean(manage)); await delay(800); await shot("held-4-after-manage");
});
// ---------------------------------------------------------------- removed from the team while on its page
if (STAGE.has("removed")) await step("a teammate removed while on the team's page", async () => {
  await fresh({ name: "Dana Second", email: EMAIL.member }); await popups("removed");
  await signInBySheet(EMAIL.member); await escape(); await escape(); await delay(800);
  await clickTile("Acme"); await delay(6000); await popups("removed-team"); await shot("removed-1-before");
  control({ removed: true });
  const left = await signedPost(CLOUD.team, "/api/cloud/team/member-left", { email: EMAIL.member }); note("Admin tells the Team Cloud", left.status === 200, await left.text());
  await delay(9000); await shot("removed-2-right-after");
  await delay(20000); await shot("removed-3-30s-later"); note("removed: where the window is", true, (await targets()).filter(isMain).map((t) => t.url)); note("removed: rail", true, await railPlaces());
  note("removed: screen says", true, await within(main, (page) => page.eval(`document.body.innerText.slice(0, 500)`)));
});
await quit().catch(() => {});
writeFileSync(join(OUT, "admin-requests.json"), JSON.stringify(adminLog().filter((row) => row.side === "admin" && (row.unknown || row.event || row.path?.includes("checkout"))), null, 1));
console.log("walk finished");
process.exit(0);
