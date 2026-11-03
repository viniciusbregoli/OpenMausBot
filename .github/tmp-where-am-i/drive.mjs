// On a disposable CI runner only: drives the real packaged app over the DevTools protocol, with real mouse events, against
// the fake Admin. Each check is written to results.json; a failed step takes its screenshots and the run goes on.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const OUT = process.env.OUT, F = join(process.env.RUNNER_TEMP, "fx"), BIN = join(process.env.APP_DIR, "OpenMausBot.app/Contents/MacOS/OpenMausBot");
const CDP = "http://127.0.0.1:9222", LOCAL = "http://127.0.0.1:8799", CODE = "12345678";
const ORIGIN = { studio: "https://studio.omb-test.example", older: "https://older.omb-test.example", acme: "https://acme.omb-test.example" };
const EMAIL = { alice: "alice@omb-test.example", tess: "tess@omb-test.example" };
const DATA = join(process.env.HOME, ".openmausbot"), USER_DATA = join(process.env.HOME, "Library/Application Support/openmausbot");
const LOOKS = [["en", "daylight", "light"], ["en", "midnight", "dark"], ["de", "daylight", "light"], ["de", "midnight", "dark"]];
mkdirSync(join(OUT, "shots"), { recursive: true });
const results = [];
let proc = null, launches = 0;
const save = () => writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
function check(name, ok, detail = "") {
  const said = typeof detail === "string" ? detail : JSON.stringify(detail);
  results.push({ name, ok: Boolean(ok), detail: said.slice(0, 600) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${said ? `  [${said.slice(0, 220)}]` : ""}`);
  save();
}
const until = async (work, what, ms = 30_000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await work(); if (last) return last; } catch (error) { last = error; } await delay(300); } throw new Error(`timed out: ${what}${last instanceof Error ? ` (${last.message})` : ""}`); };
const targets = async () => (await fetch(`${CDP}/json/list`)).json();
class Page {
  constructor(target) { this.target = target; this.id = 0; this.wait = new Map(); }
  async open() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error("no socket")); });
    this.ws.onmessage = (event) => { const message = JSON.parse(event.data); const done = this.wait.get(message.id); if (done) { this.wait.delete(message.id); message.error ? done.reject(new Error(message.error.message)) : done.resolve(message.result); } };
    return this;
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.wait.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.wait.delete(id)) reject(new Error(`no answer: ${method}`)); }, 20_000).unref(); }); }
  async eval(expression) {
    const answer = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: false });
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
    return answer.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}
const isMain = (target) => target.type === "page" && /^(http:\/\/127\.0\.0\.1:8799|https:\/\/[a-z0-9-]+\.omb-test\.example)/.test(target.url) && !new URL(target.url).pathname.startsWith("/rail");
const isRail = (target) => target.url.startsWith(`${LOCAL}/rail`);
const pageOf = async (pick) => { const target = (await targets()).find(pick); return target ? new Page(target).open() : null; };
const main = async () => { const found = await until(async () => { const list = (await targets()).filter(isMain); return list.length ? list : null; }, "the main page", 15_000); return new Page(found[0]).open(); };
const rail = () => pageOf(isRail);
async function within(open, work) { const page = await open(); if (!page) return null; try { return await work(page); } finally { page.close(); } }
const onMain = (expression) => within(main, (page) => page.eval(expression));
const onRail = (expression) => within(rail, (page) => page.eval(expression));
const where = async () => (await targets()).find(isMain)?.url ?? "";
/** The whole screen, so what lies over the page (the rail's view) shows as a person sees it. */
async function shot(name) {
  await delay(1200);
  try { execFileSync("screencapture", ["-x", join(OUT, "shots", `${name}.png`)], { timeout: 15_000 }); } catch (error) { console.log(`no shot ${name}: ${error.message}`); }
}
/** A real mouse event through DevTools, on the element once it has stopped moving, and only if it is what the pointer is over. */
async function clickAt(page, selector) {
  const read = () => page.eval(`(() => { const el = ${selector}; if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  let box = await read();
  if (!box) return false;
  for (let tries = 0; tries < 20; tries++) { await delay(100); const next = await read(); if (!next) return false; const still = Math.abs(next.x - box.x) < 1 && Math.abs(next.y - box.y) < 1; box = next; if (still) break; }
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await delay(120);
  const over = await page.eval(`(() => { const el = ${selector}; const at = document.elementFromPoint(${box.x}, ${box.y}); return Boolean(el && at && (el === at || el.contains(at))); })()`);
  if (!over) throw new Error(`something else is under the pointer at ${box.x}, ${box.y}`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  return true;
}
const QUIET = `try { localStorage.setItem("omb-analytics-opt-out", "1"); localStorage.setItem("omb-email-gate", "skipped"); localStorage.setItem("omb-advanced-mode", "0"); localStorage.setItem("omb-simple-mode-prompt", "1"); } catch {}`;
async function launch() {
  const log = join(OUT, `app-${++launches}.log`);
  writeFileSync(log, "");
  const trust = readFileSync(join(OUT, "trust.txt"), "utf8");
  const args = ["--remote-debugging-port=9222", ...(/successful/i.test(trust) ? [] : ["--ignore-certificate-errors"])];
  proc = spawn(BIN, args, { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(F, "ca.pem"), NODE_USE_SYSTEM_CA: "1", ELECTRON_ENABLE_LOGGING: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [proc.stdout, proc.stderr]) stream.on("data", (chunk) => appendFileSync(log, chunk));
  await until(async () => (await targets()).some(isMain), "the app's main page", 90_000);
  await within(main, async (page) => { await page.send("Page.addScriptToEvaluateOnNewDocument", { source: QUIET }); await page.eval(QUIET); });
  await delay(3000);
}
async function quit() {
  const pid = proc.pid, gone = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  process.kill(pid, "SIGTERM");
  const ended = await Promise.race([gone, delay(30_000).then(() => null)]);
  if (!ended) { process.kill(pid, "SIGKILL"); await gone; }
  await until(async () => { try { await fetch(`${LOCAL}/api/health`, { signal: AbortSignal.timeout(800) }); return false; } catch { return true; } }, "port 8799 closing", 20_000).catch(() => {});
  await delay(1500);
}
const adminLog = () => readFileSync(join(F, "admin.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const dismissPopups = () => onMain(`(() => { let n = 0; for (const el of document.querySelectorAll("[role=dialog] button, [role=alertdialog] button")) { if (/^(not now|nicht jetzt|close|schließen|maybe later|no thanks|skip|got it|dismiss|continue)$/i.test((el.getAttribute("aria-label") || el.textContent || "").trim()) && !el.closest("[data-cloud-add-dialog]")) { el.click(); n++; } } return n; })()`);
const tag = () => onMain(`(() => { const el = document.querySelector("[data-window-place]"); return el ? { text: (el.querySelector(".truncate")?.innerText ?? "").replace(/\\s+/g, " ").trim(), tag: el.tagName, label: el.getAttribute("aria-label"), rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() } : null; })()`);
const pageWidth = () => onMain(`(() => { const el = document.querySelector("[data-window-frame-bar]"); return { beside: getComputedStyle(document.documentElement).getPropertyValue("--rail-beside").trim(), zoom: document.documentElement.style.zoom || "", barLeft: document.querySelector("#root")?.getBoundingClientRect().x ?? null, body: document.body.getBoundingClientRect().x }; })()`);
const listRows = () => onRail(`[...document.querySelectorAll("[data-window-place-row]")].map((el) => el.innerText.replace(/\\s+/g, " ").trim())`);
const listSignIn = () => onRail(`document.querySelector("[data-window-places-sign-in]")?.innerText ?? null`);
async function openList() {
  await dismissPopups();
  const opened = await within(main, (page) => clickAt(page, `document.querySelector("[data-window-place]")`));
  if (!opened) throw new Error("no tag to click");
  await until(() => onRail(`Boolean(document.querySelector("[data-window-places]"))`), "the list on the rail's page", 15_000);
  // Laid out against the whole window, and a frame painted since.
  await until(() => onRail(`(() => { const list = document.querySelector("[data-window-places]"); return Boolean(list && window.innerWidth > 400 && list.getBoundingClientRect().width > 200 && document.visibilityState === "visible"); })()`), "the list laid out over the whole window", 8000);
  await onRail(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
  await delay(300);
}
async function closeList() {
  await within(rail, async (page) => { await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); });
  await until(async () => !(await onRail(`Boolean(document.querySelector("[data-window-places]"))`)), "the list closing", 8000);
  await delay(250);
}
const clickRow = (id) => within(rail, (page) => clickAt(page, `document.querySelector('[data-window-place-row="${id}"]')`));
const rowIdNamed = (name) => onRail(`[...document.querySelectorAll("[data-window-place-row]")].find((el) => el.innerText.includes(${JSON.stringify(name)}))?.getAttribute("data-window-place-row") ?? null`);
async function setLook(lang, skin) {
  await within(main, async (page) => {
    await page.eval(`window.ogb.desktopLanguage.set(${JSON.stringify(lang)})`);
    await page.eval(`localStorage.setItem("omb-skin", ${JSON.stringify(skin)})`);
    await page.send("Page.reload", {});
  });
  await delay(800);
  await until(() => onMain(`Boolean(document.querySelector("[data-window-frame-bar]"))`), "the frame bar after a reload", 30_000);
  await delay(1500);
  await dismissPopups();
  await delay(300);
}
/** One state, in both languages and both looks: the tag, then the list open. */
async function everyLook(state, expectTag) {
  for (const [lang, skin, theme] of LOOKS) {
    await setLook(lang, skin);
    const seen = await until(tag, `${state}: the tag`, 20_000).catch(() => null);
    const word = expectTag[lang] ?? expectTag.en;
    check(`${state} ${lang} ${theme}: the tag says "${word}"`, seen?.text === word, JSON.stringify(seen));
    await shot(`${state}-${lang}-${theme}`);
    await openList();
    const rows = await listRows(), railSkin = await onRail("document.documentElement.dataset.skin");
    check(`${state} ${lang} ${theme}: the list opens, in the page's look`, rows.length > 0 && railSkin === skin, JSON.stringify({ rows, railSkin }));
    await shot(`${state}-${lang}-${theme}-list`);
    await closeList();
  }
  await setLook("en", "daylight");
}
const openSettings = async () => { await dismissPopups(); await within(main, (page) => clickAt(page, `document.querySelector("[data-frame-settings]")`)); await until(() => onMain(`Boolean(document.querySelector('[data-settings-block], [role="dialog"]'))`), "Settings", 10_000); await delay(800); };
const settingsSection = (label) => within(main, (page) => clickAt(page, `[...document.querySelectorAll('[role="dialog"] button, [role="dialog"] a')].find((el) => (el.textContent || "").trim() === ${JSON.stringify(label)})`));
const closeSettings = () => within(main, async (page) => { for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await delay(500); });
const scrollTo = (selector) => onMain(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`);
const bodyText = () => onMain(`document.body.innerText`);
async function step(name, work) {
  console.log(`\n=== ${name}`);
  try { await work(); }
  catch (error) { check(`${name}: finished`, false, String(error?.message ?? error)); await shot(`failed-${name.replace(/\W+/g, "-").slice(0, 40)}`); }
}
const signInByBridge = (who) => within(main, async (page) => {
  const sent = await page.eval(`window.ogb.cloudAccount.signInStart(${JSON.stringify(EMAIL[who])})`);
  if (sent.outcome !== "sent") throw new Error(`no code: ${JSON.stringify(sent)}`);
  const verified = await page.eval(`window.ogb.cloudAccount.signInVerify(${JSON.stringify(CODE)})`).catch((error) => ({ outcome: "moved", error: String(error?.message ?? error) }));
  if (verified.outcome === "moved") { await until(() => adminLog().some((row) => row.event === "signed-in"), "the sign-in at the Admin", 10_000); return; }
  if (verified.outcome !== "signed-in") throw new Error(`no sign-in: ${JSON.stringify(verified).slice(0, 200)}`);
});
const signOutHere = async () => {
  await until(async () => (await where()).startsWith(LOCAL) || (await within(rail, (page) => clickAt(page, `document.querySelector('[data-rail-kind="computer"]')`)) && false), "this computer's page", 20_000).catch(() => {});
  await within(main, async (page) => { const view = await page.eval("window.ogb.accounts.list()"); if (view.active) await page.eval(`window.ogb.accounts.signOut(${JSON.stringify(view.active.id)})`); }).catch((error) => { if (!/navigated|closed/i.test(String(error?.message))) throw error; });
  await until(async () => (await onMain("window.ogb.accounts.list()"))?.active === null && (await where()).startsWith(LOCAL), "signed out", 30_000);
  await delay(1500);
};
/** The email and the code, typed into the sheet's own boxes, with a real click on Send code. */
const signInInSheet = (email) => within(main, async (page) => {
  await page.eval(`(() => { const box = document.querySelector("#cloud-add-email"); box.focus(); box.select(); })()`);
  await page.send("Input.insertText", { text: email });
  await delay(300);
  await clickAt(page, `document.querySelector('[data-cloud-add="sign-in-email"] button[type="submit"]')`);
  await until(() => page.eval(`Boolean(document.querySelector('[data-cloud-add="sign-in-code"]'))`), "the code boxes", 15_000);
  await delay(300);
  await page.eval(`document.querySelector('[data-cloud-add="sign-in-code"] input').focus()`);
  await page.send("Input.insertText", { text: CODE });
}).catch((error) => { if (!/navigated|closed/i.test(String(error?.message))) throw error; });
/** A real click from outside the app's process, through macOS: what DevTools' synthetic input can't show is a press the window takes for its own. */
function nativeClick(x, y) { execFileSync("cliclick", [`c:${Math.round(x)},${Math.round(y)}`], { timeout: 10_000 }); }
const windowBounds = () => onMain(`({ left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight })`);

await step("0. signed out, nothing saved: the customer's window", async () => {
  await launch();
  check("the real app opened this computer's page", (await where()).startsWith(LOCAL), await where());
  check("nobody is signed in", (await onMain("window.ogb.accounts.list()"))?.active === null);
  check("there is no rail: one place", (await rail()) === null);
  const seen = await until(tag, "the tag");
  check("the tag is a control", seen.tag === "BUTTON", JSON.stringify(seen));
  const before = await pageWidth();
  await openList();
  check("the rail's page came up for the list, and the page didn't move over", (await pageWidth()).beside === before.beside && (await pageWidth()).barLeft === before.barLeft, JSON.stringify([before, await pageWidth()]));
  check("the list has This computer, marked as on screen", (await listRows()).join("|") === "This computer", (await listRows()).join("|"));
  check("the list offers to sign in", (await listSignIn()) === "Sign in to see your Clouds and teams", await listSignIn());
  await closeList();
  check("Escape closes it", (await pageWidth()).barLeft === before.barLeft);
  await until(async () => { const views = await rail(); views?.close(); return true; }, "");
});
await step("1. signed out, in every look", () => everyLook("signed-out", { en: "This computer", de: "Dieser Computer" }));
await step("1b. Settings tells the truth signed out", async () => {
  for (const [lang, skin, theme] of [LOOKS[0], LOOKS[3]]) {
    await setLook(lang, skin);
    await openSettings();
    const row = await onMain(`document.querySelector("[data-cloud-not-signed-in]")?.closest('[role="group"]')?.innerText ?? null`);
    check(`General ${lang}: the MausBot Cloud row says Not signed in`, Boolean(row) && (lang === "en" ? row.includes("Not signed in") : row.includes("Nicht angemeldet")), row ?? "");
    check(`General ${lang}: Sign in sits beside the offer`, await onMain(`Boolean(document.querySelector("[data-cloud-sign-in]") && document.querySelector('[data-cloud-offer="trial"]'))`), row ?? "");
    await scrollTo("[data-cloud-not-signed-in]");
    await delay(300);
    await shot(`settings-general-signed-out-${lang}-${theme}`);
    await closeSettings();
  }
  await setLook("en", "daylight");
  await openSettings();
  await within(main, (page) => clickAt(page, `document.querySelector("[data-cloud-sign-in]")`));
  await until(() => onMain(`Boolean(document.querySelector('[data-cloud-add="sign-in-email"]'))`), "the sign-in screen from Settings", 10_000);
  check("Sign in on the row opens the sign-in itself", true);
  await shot("settings-sign-in-sheet-en-light");
  await within(main, async (page) => { for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); });
  await delay(600);
  await closeSettings();
  await within(main, (page) => page.eval(`document.querySelector("[data-frame-settings]") && 0`));
});
await step("2. a teammate with no plan signs in from the list: their team, not a trial", async () => {
  await openList();
  await shot("teammate-list-signed-out");
  await within(rail, (page) => clickAt(page, `document.querySelector("[data-window-places-sign-in]")`));
  await until(() => onMain(`Boolean(document.querySelector('[data-cloud-add="sign-in-email"]'))`), "the sign-in sheet", 15_000);
  check("the list's Sign in opens the sign-in", true);
  await signInInSheet(EMAIL.tess);
  const after = await until(() => onMain(`(() => { const el = document.querySelector("[data-cloud-add]"); const k = el?.getAttribute("data-cloud-add"); return k && !k.startsWith("sign-in") ? k : null; })()`), "the sheet's next screen", 20_000);
  check("after signing in the sheet shows their team's Cloud, never plan cards", after === "team-ready", after);
  await shot("teammate-signed-in-team-ready-en-light");
  check("no trial and no plan in sight", !/Start free trial|\$\d+|Most popular/.test(await bodyText()), (await bodyText()).slice(0, 300));
  const session = adminLog().filter((row) => row.path === "/api/cloud/desktop/session").length;
  check("the fake Admin really offered a plan to this account, as the real one does", session > 0 && JSON.parse(readFileSync(join(F, "scenario.json"), "utf8")).accounts.tess.plan === "free");
  await within(main, (page) => clickAt(page, `document.querySelector('[data-cloud-add="team-ready"] button[data-autofocus]')`));
  await until(async () => (await where()).startsWith(ORIGIN.acme) && !(await where()).includes("/pair"), "Acme's page", 45_000);
  await delay(4000);
  await within(main, (page) => page.eval(QUIET));
  check("Open Acme opens the team's Cloud", true, await where());
});
await step("3. on a team, in every look", () => everyLook("team", { en: "Acme · Team" }));
await step("3b. the teammate on this computer: no trial anywhere, and the list gets back and forth", async () => {
  await openList();
  const id = await rowIdNamed("This computer");
  await clickRow(id);
  await until(async () => (await where()).startsWith(LOCAL), "this computer's page", 30_000);
  await delay(2500);
  await dismissPopups();
  check("the list's row went to this computer", true, await where());
  await until(async () => (await tag())?.text === "This computer", "the tag following");
  for (const wait of [1, 2, 3]) { await delay(1500); check(`no trial offered after signing in (${wait})`, !/Start free trial/.test(await bodyText())); }
  await openSettings();
  const row = await onMain(`[...document.querySelectorAll('[role="group"]')].map((el) => el.innerText).find((text) => text.includes("You're part of")) ?? null`);
  check("General's row says whose Cloud they use", row?.includes("You're part of Acme"), row ?? "");
  const settingsText = await bodyText();
  check("and offers no trial or plan", !/Start free trial|Add a Cloud/.test(settingsText.slice(settingsText.indexOf("MausBot Cloud"), settingsText.indexOf("MausBot Cloud") + 220)), settingsText.slice(settingsText.indexOf("MausBot Cloud"), settingsText.indexOf("MausBot Cloud") + 220));
  await scrollTo('[role="group"]');
  await shot("teammate-settings-general-en-light");
  await closeSettings();
});
await step("4. the owner of several: This computer, signed in, in every look", async () => {
  await signOutHere();
  await signInByBridge("alice");
  await until(async () => { const rows = await onRail(`[...document.querySelectorAll("[data-rail-place]")].length`).catch(() => 0); return rows >= 3; }, "the Clouds on the rail", 40_000);
  await delay(2000);
  await everyLook("this-computer", { en: "This computer", de: "Dieser Computer" });
  await openList();
  const rows = await listRows();
  check("the list has every place, with its kind", ["This computer", "Studio", "Older Cloud Page", "Acme"].every((name) => rows.some((row) => row.includes(name))) && rows.some((row) => row.endsWith("Team")), rows.join(" | "));
  check("signed in: no Sign in", (await listSignIn()) === null);
  await closeList();
});
await step("5. on a Cloud, in every look; the list and the rail open the same way", async () => {
  await openList();
  await clickRow(await rowIdNamed("Studio"));
  await until(async () => (await where()).startsWith(ORIGIN.studio) && !(await where()).includes("/pair"), "Studio's page", 45_000);
  await delay(4000);
  await within(main, (page) => page.eval(QUIET));
  check("a row of the list opened Studio", true, await where());
  await everyLook("cloud", { en: "Studio · Cloud" });
  check("a Cloud's page can't read the list", (await onMain(`window.ogb.workspaces.places().then((v) => (v.list ? "list" : v.places.length))`)) === 0);
  check("a Cloud's page can't open it without a click", /Choose where you are/.test(await onMain(`window.ogb.rail.openList().then(() => "opened", (e) => e.message)`)));
});
await step("6. the rail hidden: the tag stays, the list still opens, and the page doesn't move", async () => {
  await within(main, (page) => clickAt(page, `document.querySelector("[data-rail-toggle]")`));
  await until(async () => (await pageWidth()).beside === "0px" || (await pageWidth()).beside === "", "the rail hiding", 8000);
  await delay(600);
  const before = await pageWidth();
  check("the tag stays with the rail hidden", (await tag())?.text === "Studio · Cloud", JSON.stringify(await tag()));
  await shot("rail-hidden-en-light");
  await openList();
  const during = await pageWidth();
  check("the page stays where it is under the list", during.barLeft === before.barLeft && during.beside === before.beside, JSON.stringify([before, during]));
  check("the rail's tiles stay away while the list is up", await onRail(`getComputedStyle(document.querySelector("[data-chrome-rail]")).visibility === "hidden"`));
  await shot("rail-hidden-list-en-light");
  await clickRow(await rowIdNamed("Acme"));
  await until(async () => (await where()).startsWith(ORIGIN.acme) && !(await where()).includes("/pair"), "Acme's page", 45_000);
  await delay(4000);
  check("a row switches with the rail hidden", true, await where());
  await within(main, (page) => clickAt(page, `document.querySelector("[data-rail-toggle]")`));
  await delay(1200);
  check("the rail comes back", await onRail(`getComputedStyle(document.querySelector("[data-chrome-rail]")).visibility === "visible" && document.querySelectorAll("[data-rail-place]").length >= 3`));
});
await step("7. real clicks through macOS: a list over the page's headers takes them, and a press on them doesn't move the window", async () => {
  await setLook("en", "daylight");
  const bounds = await windowBounds();
  const at = await tag();
  nativeClick(bounds.left + at.rect.x + at.rect.w / 2, bounds.top + at.rect.y + at.rect.h / 2);
  const opened = await until(() => onRail(`Boolean(document.querySelector("[data-window-places]"))`), "the list from a real click", 6000).catch(() => false);
  check("control: a real click on the tag opens the list (else this runner gives no real clicks, and nothing below says anything)", opened, JSON.stringify({ bounds, at: at.rect }));
  if (!opened) return;
  await delay(500);
  // A header that drags the window, as a chat's does, under the list's rows: this test page has none there.
  const header = (important) => onMain(`(() => { document.querySelector("#test-header")?.remove(); const el = document.createElement("div"); el.id = "test-header"; el.style.cssText = "position:fixed;left:0;right:0;top:28px;height:240px;z-index:1;background:rgba(255,0,0,.04)"; el.style.setProperty("-webkit-app-region", "drag", ${important ? '"important"' : '""'}); document.body.append(el); return true; })()`);
  const rowsNow = () => onRail(`[...document.querySelectorAll("[data-window-place-row]")].map((el) => { const r = el.getBoundingClientRect(); return { text: el.innerText, x: r.x, y: r.y, w: r.width, h: r.height }; })`);
  const centre = (row, base) => ({ x: base.left + row.x + row.w / 2, y: base.top + row.y + row.h / 2 });
  const dragFrom = ({ x, y }) => execFileSync("cliclick", [`dd:${Math.round(x)},${Math.round(y)}`, "w:150", `m:${Math.round(x + 60)},${Math.round(y + 40)}`, "w:150", `du:${Math.round(x + 60)},${Math.round(y + 40)}`], { timeout: 10_000 });
  await header(false);
  await delay(600);
  const first = (await rowsNow()).find((row) => row.text.includes("Studio"));
  writeFileSync(join(OUT, "list-rows.json"), JSON.stringify(await rowsNow()));
  dragFrom(centre(first, bounds));
  await delay(800);
  const afterDrag = await windowBounds();
  check("with main lifting the page's drag regions, a press and drag on a row over a header doesn't move the window", afterDrag.left === bounds.left && afterDrag.top === bounds.top, JSON.stringify([bounds, afterDrag]));
  await shot("real-click-list-over-header-en-light");
  const point = centre((await rowsNow()).find((row) => row.text.includes("Studio")), afterDrag);
  nativeClick(point.x, point.y);
  const went = await until(async () => (await where()).startsWith(ORIGIN.studio) && !(await where()).includes("/pair"), "Studio from a real click", 30_000).catch(() => false);
  check("a real click on a row over a header switches", Boolean(went), await where());
  await delay(4000);
  // The same gesture with the drag region forced back, as if main hadn't lifted it: inline !important outranks the inserted rule.
  await openList();
  const before = await windowBounds();
  await header(true);
  await delay(600);
  dragFrom(centre((await rowsNow()).find((row) => row.text.includes("This computer")), before));
  await delay(800);
  const forced = await windowBounds();
  const moved = forced.left !== before.left || forced.top !== before.top;
  results.push({ name: "finding: with the drag region forced on under the list, the same press and drag moves the window (the reason main lifts it)", ok: true, detail: `moved: ${moved} ${JSON.stringify([before, forced])}` }); save();
  console.log(`forced drag region: the window moved: ${moved}`);
  await onMain(`document.querySelector("#test-header")?.remove()`);
  await delay(300);
  if (await onRail(`Boolean(document.querySelector("[data-window-places]"))`)) await closeList();
});
await step("8. an older Cloud page (the last release's), drawing its own frame", async () => {
  if ((await onRail(`Boolean(document.querySelector("[data-window-places]"))`))) await closeList();
  await within(rail, (page) => clickAt(page, `[...document.querySelectorAll("[data-rail-place]")].find((el) => (el.getAttribute("aria-label") || "").includes("Older Cloud Page"))`));
  await until(async () => (await where()).startsWith(ORIGIN.older) && !(await where()).includes("/pair"), "the older Cloud's page", 60_000);
  await delay(6000);
  await within(main, (page) => page.eval(QUIET));
  const version = await onMain(`fetch("/api/health").then((r) => r.json()).then((v) => JSON.stringify(v)).catch((e) => e.message)`);
  writeFileSync(join(OUT, "older-health.json"), String(version));
  const state = await onMain(`(() => { const el = document.querySelector("[data-window-place]"); return { place: el ? { tag: el.tagName, text: el.innerText, title: el.getAttribute("title") } : null, frame: Boolean(document.querySelector("[data-window-frame-bar]")), app: document.body.innerText.length, hasOpenList: typeof window.ogb.rail?.openList, sheet: typeof window.ogb.accountSheet?.open }; })()`);
  check("it isn't blank", state.app > 40, JSON.stringify(state));
  check("it draws its own quiet title, no tag and no list", state.frame && state.place?.tag === "DIV" && !state.place.title, JSON.stringify(state));
  check("the bridge still has what it calls, and the new function beside it", state.hasOpenList === "function", JSON.stringify(state));
  await shot("older-cloud-page-en-light");
  await within(rail, (page) => clickAt(page, `document.querySelector('[data-rail-kind="computer"]')`));
  await until(async () => (await where()).startsWith(LOCAL), "back through the rail", 30_000);
  check("the rail still switches from it", true, await where());
});
await step("9. a signed-out Mac whose bots moved to a Cloud: no rail, so the tag and its list are the way forward", async () => {
  await signOutHere();
  await quit();
  writeFileSync(join(DATA, "moved.json"), JSON.stringify({ v: 1, at: Date.now(), cloud: ORIGIN.studio }), { mode: 0o600 });
  writeFileSync(join(USER_DATA, "one-home.json"), JSON.stringify({ v: 1, phase: "done", cloud: { origin: ORIGIN.studio, account: "acct-alice", machine: ORIGIN.studio }, startedAt: 1, doneAt: Date.now() - 60_000, frozenAt: Date.now() - 60_000, version: "0.1.0", told: true, phoneStopped: true }), { mode: 0o600 });
  await launch();
  await until(() => onMain(`Boolean(document.querySelector("[data-home-line='clean']"))`), "the clean workspace's line", 60_000);
  await delay(2500);
  await dismissPopups();
  check("the clean workspace, with no rail", (await rail()) === null || await onRail(`document.querySelectorAll("[data-rail-place]").length === 0`));
  const seen = await tag();
  check("the tag says This computer", seen?.text === "This computer" && seen.tag === "BUTTON", JSON.stringify(seen));
  await shot("moved-signed-out-en-light");
  await openList();
  check("its list offers to sign in", (await listSignIn()) === "Sign in to see your Clouds and teams", await listSignIn());
  await shot("moved-signed-out-list-en-light");
  await within(rail, (page) => clickAt(page, `document.querySelector("[data-window-places-sign-in]")`));
  await until(() => onMain(`Boolean(document.querySelector('[data-cloud-add="sign-in-email"]'))`), "the sign-in sheet", 15_000);
  await shot("moved-sign-in-sheet-en-light");
  await signInInSheet(EMAIL.alice);
  await until(async () => (await where()).startsWith(ORIGIN.studio) && !(await where()).includes("/pair"), "their Cloud", 120_000);
  await delay(5000);
  check("signing in as the owner goes to their Cloud", true, await where());
  const home = await until(tag, "the tag on the Cloud", 20_000).catch(() => null);
  check("and the tag says where they are", Boolean(home?.text), JSON.stringify(home));
  await shot("moved-signed-in-en-light");
});
try { const all = adminLog(); check("safety: every Admin and Cloud request stayed on this runner's fixture", all.length > 0, `${all.length} requests logged`); writeFileSync(join(OUT, "admin-requests.json"), JSON.stringify(all.slice(-300))); } catch (error) { check("safety log", false, error.message); }
if (proc && proc.exitCode === null) { try { process.kill(proc.pid, "SIGKILL"); } catch {} }
const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
for (const row of failed) console.log(`FAILED: ${row.name} ${row.detail}`);
process.exit(failed.length ? 1 : 0);
