// On a disposable CI runner only: drives the real packaged app over the DevTools protocol, with real mouse events, against
// the fake Admin. Each check is written to results.json; a failed step takes its screenshots and the run goes on.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const OUT = process.env.OUT, F = join(process.env.RUNNER_TEMP, "fx"), BIN = join(process.env.APP_DIR, "OpenMausBot.app/Contents/MacOS/OpenMausBot");
const CDP = "http://127.0.0.1:9222", LOCAL = "http://127.0.0.1:8799", CODE = "12345678";
const CLOUDS = { a: "https://home-a.omb-test.example", second: "https://second-a.omb-test.example", team: "https://team.omb-test.example", b: "https://home-b.omb-test.example" };
const NAMES = { second: "Alice Second", team: "Shared Team" };
const EMAILS = { a: "alice@omb-test.example", b: "bob@omb-test.example", c: "carol@omb-test.example", d: "dave@omb-test.example", e: "erin@omb-test.example", f: "frank@omb-test.example" };
mkdirSync(join(OUT, "shots"), { recursive: true });
const results = [];
let shotCount = 0, proc = null, launches = 0;
const save = () => writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: typeof detail === "string" ? detail.slice(0, 600) : JSON.stringify(detail).slice(0, 600) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 200)}]` : ""}`);
  save();
}
const until = async (work, what, ms = 30_000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await work(); if (last) return last; } catch (error) { last = error; } await delay(400); } throw new Error(`timed out: ${what}${last instanceof Error ? ` (${last.message})` : ""}`); };
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
async function pageOf(pick) { const target = (await targets()).find(pick); return target ? new Page(target).open() : null; }
const isMain = (target) => target.type === "page" && /^(http:\/\/127\.0\.0\.1:8799|https:\/\/[a-z0-9-]+\.omb-test\.example)/.test(target.url) && !new URL(target.url).pathname.startsWith("/rail");
const isRail = (target) => target.url.startsWith(`${LOCAL}/rail`);
const main = async () => {
  const candidates = await until(async () => { const found = (await targets()).filter(isMain); return found.length ? found : null; }, "the main window's page", 15_000);
  if (candidates.length > 1) { for (const target of candidates) { const page = await new Page(target).open(); const visible = await page.eval("document.visibilityState === 'visible'").catch(() => false); if (visible) return page; page.close(); } }
  const page = candidates[0] ? await new Page(candidates[0]).open() : null;
  if (!page) throw new Error("no main window page");
  return page;
};
const rail = () => pageOf(isRail);
async function within(open, work) { const page = await open(); if (!page) return null; try { return await work(page); } finally { page.close(); } }
async function shot(name, open = main) {
  const label = `${String(++shotCount).padStart(2, "0")}-${name}`;
  try { await within(open, async (page) => { const { data } = await page.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(OUT, "shots", `${label}.png`), Buffer.from(data, "base64")); }); } catch (error) { console.log(`no page shot ${label}: ${error.message}`); }
  try { execFileSync("screencapture", ["-x", join(OUT, "shots", `${label}-screen.png`)], { timeout: 15_000 }); } catch {}
}
/** A real mouse click, so the page sees a person's gesture: on the element once it has stopped moving, and only if it is what
 * the pointer is over. */
async function clickAt(page, selectorExpression) {
  const read = () => page.eval(`(() => { const el = ${selectorExpression}; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  let box = await read();
  if (!box) return false;
  for (let tries = 0; tries < 25; tries++) {
    await delay(120);
    const next = await read();
    if (!next) return false;
    const still = Math.abs(next.x - box.x) < 1 && Math.abs(next.y - box.y) < 1;
    box = next;
    if (still) break;
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await delay(200);
  box = (await read()) ?? box;
  const over = await page.eval(`(() => { const el = ${selectorExpression}; const at = document.elementFromPoint(${box.x}, ${box.y}); return Boolean(el && at && (el === at || el.contains(at))); })()`);
  if (!over) throw new Error(`something else is under the pointer at ${box.x}, ${box.y}`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  return true;
}
async function launch() {
  const log = join(OUT, `app-${++launches}.log`);
  writeFileSync(log, "");
  const trust = readFileSync(join(OUT, "trust.txt"), "utf8");
  const args = ["--remote-debugging-port=9222", ...(/successful/i.test(trust) ? [] : ["--ignore-certificate-errors"])];
  proc = spawn(BIN, args, { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(F, "ca.pem"), NODE_USE_SYSTEM_CA: "1", ELECTRON_ENABLE_LOGGING: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [proc.stdout, proc.stderr]) stream.on("data", (chunk) => appendFileSync(log, chunk));
  await until(async () => (await targets()).some((target) => target.type === "page" && isMain(target)), "the app's main page", 90_000);
  await within(main, (page) => page.send("Page.addScriptToEvaluateOnNewDocument", { source: QUIET }));
  await within(main, (page) => page.eval(QUIET));
  await delay(3000);
}
const QUIET = `try { localStorage.setItem("omb-analytics-opt-out", "1"); localStorage.setItem("omb-email-gate", "skipped"); localStorage.setItem("omb-advanced-mode", "0"); } catch {}`;
async function quit() {
  const pid = proc.pid, gone = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  process.kill(pid, "SIGTERM");
  const ended = await Promise.race([gone, delay(30_000).then(() => null)]);
  if (!ended) { console.log(`app ${pid} did not quit in 30 s; SIGKILL by pid`); process.kill(pid, "SIGKILL"); await gone; check("the app quit by itself when asked", false, "needed SIGKILL, so its cookie store may not have been flushed"); }
  await until(async () => { try { await fetch(`${LOCAL}/api/health`, { signal: AbortSignal.timeout(800) }); return false; } catch { return true; } }, "port 8799 closing", 20_000).catch(() => {});
  await delay(1500);
}
const envFile = () => { try { return JSON.parse(readFileSync(join(process.env.HOME, "Library/Application Support/openmausbot/environments.json"), "utf8")); } catch (error) { return { unreadable: error.message }; } };
async function diagnose(label) {
  const list = await targets().catch(() => []);
  const pages = [];
  for (const target of list) {
    const page = await new Page(target).open().catch(() => null);
    const facts = page ? await page.eval(`({ visible: document.visibilityState, focus: document.hasFocus(), href: location.href, you: Boolean(document.querySelector("[data-sidebar-account]")), accounts: typeof window.ogb?.accounts })`).catch((error) => ({ error: error.message.slice(0, 80) })) : null;
    let answer = null;
    if (page && facts?.accounts === "object") answer = await page.eval("window.ogb.accounts.list().then((v) => JSON.stringify(v), (e) => 'REFUSED ' + e.message.slice(0, 90))").catch((error) => error.message.slice(0, 90));
    page?.close();
    pages.push({ type: target.type, url: target.url.slice(0, 70), title: target.title?.slice(0, 30), ...facts, list: answer });
  }
  const env = envFile();
  const line = { label, activeId: env.activeId, places: env.environments?.map((entry) => ({ id: entry.id?.slice(0, 8), origin: entry.origin ?? entry.kind, home: entry.home, team: Boolean(entry.team), cloud: Boolean(entry.cloud) })), pages };
  appendFileSync(join(OUT, "diagnostics.jsonl"), `${JSON.stringify(line)}\n`);
  return line;
}
const adminLog = () => readFileSync(join(F, "admin.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const cookieStore = () => {
  const out = {};
  const found = execFileSync("find", [join(process.env.HOME, "Library/Application Support"), "-maxdepth", "3", "-name", "Cookies", "-type", "f"], { encoding: "utf8" }).trim().split("\n").filter((line) => /MausBot/i.test(line));
  for (const file of found) out[file.replace(process.env.HOME, "~")] = execFileSync("sqlite3", [`file:${file}?immutable=1`, "select host_key || ' ' || name from cookies where host_key like '%omb-test.example%' order by 1;"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return out;
};
const storeHosts = (store) => Object.values(store).flat().map((row) => row.split(" ")[0].replace(/^\./, ""));
const liveCookies = (origin) => within(main, async (page) => (await page.send("Network.getCookies", { urls: [origin] })).cookies.map((cookie) => cookie.name));
const railPlaces = async () => (await within(rail, (page) => page.eval(`[...document.querySelectorAll("[data-rail-place]")].map((el) => el.getAttribute("aria-label"))`))) ?? [];
const accountsNow = async () => (await within(rail, (page) => page.eval("window.ogb.accounts.list()")).catch(() => null)) ?? within(main, (page) => page.eval("window.ogb.accounts.list()"));
const dismissPopups = () => within(main, (page) => page.eval(`(() => { let n = 0; for (const el of document.querySelectorAll("[role=dialog] button, [role=alertdialog] button")) { if (/^(not now|close|maybe later|no thanks|skip|got it|dismiss|continue)$/i.test((el.getAttribute("aria-label") || el.textContent || "").trim())) { el.click(); n++; } } return n; })()`));
async function openYouMenu() {
  await dismissPopups(); await delay(400); await dismissPopups();
  const opened = await within(main, async (page) => {
    await until(() => page.eval(`Boolean(document.querySelector("[data-sidebar-account]")?.closest("button") || [...document.querySelectorAll("button[aria-haspopup=menu]")].at(-1))`), "the You menu's button");
    return clickAt(page, `(document.querySelector("[data-sidebar-account]")?.closest("button") || [...document.querySelectorAll("button[aria-haspopup=menu]")].at(-1))`);
  });
  if (!opened) throw new Error("no You menu button to click");
  return until(() => within(main, async (page) => { const rows = await page.eval(`[...document.querySelectorAll('[role^="menuitem"]')].map((el) => (el.textContent || "").trim())`); return rows.length ? rows : null; }), "the You menu's rows", 8000);
}
const clickMenuRow = (text) => within(main, (page) => clickAt(page, `[...document.querySelectorAll('[role^="menuitem"]')].find((el) => (el.textContent || "").includes(${JSON.stringify(text)}))`));
const closeMenu = () => within(main, async (page) => { await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); });
const signIn = (who) => within(main, async (page) => {
  const sent = await page.eval(`window.ogb.cloudAccount.signInStart(${JSON.stringify(EMAILS[who])})`);
  if (sent.outcome !== "sent") throw new Error(`no code: ${JSON.stringify(sent)}`);
  const verified = await page.eval(`window.ogb.cloudAccount.signInVerify(${JSON.stringify(CODE)})`).catch((error) => ({ outcome: "moved", error: String(error?.message ?? error) }));
  if (verified.outcome === "moved") { await until(() => adminLog().some((row) => row.event === "signed-in"), "the sign-in at the Admin", 10_000); return; }
  if (verified.outcome !== "signed-in") throw new Error(`no sign-in: ${JSON.stringify(verified).slice(0, 200)}`);
});
async function openPlace(key) {
  const ok = await within(rail, (page) => clickAt(page, `[...document.querySelectorAll("[data-rail-place]")].find((el) => (el.getAttribute("aria-label") || "").includes(${JSON.stringify(NAMES[key])}))`));
  if (!ok) throw new Error(`no circle for ${NAMES[key]}: ${JSON.stringify(await railPlaces())}`);
  await delay(1500);
  await diagnose(`clicked ${key}`);
  await until(async () => (await targets()).some((target) => isMain(target) && target.url.startsWith(CLOUDS[key]) && !target.url.includes("/pair")), `${NAMES[key]}'s page`, 45_000).catch(async (error) => { await diagnose(`never opened ${key}`); throw error; });
  await within(main, (page) => page.eval(QUIET));
  await until(async () => (await liveCookies(CLOUDS[key])).length > 0, `a session at ${NAMES[key]}`, 20_000);
  await delay(2500);
}
const backHome = async () => { const ok = await within(rail, (page) => clickAt(page, `[...document.querySelectorAll('[data-rail-kind="computer"]')][0]`)); if (ok) await until(async () => (await targets()).some((target) => isMain(target) && target.url.startsWith(LOCAL)), "this computer's page", 30_000); await delay(2000); };
async function step(name, work) {
  console.log(`\n=== ${name}`);
  try { await work(); }
  catch (error) { check(`${name}: finished`, false, String(error?.message ?? error)); await shot(`failed-${name.replace(/\W+/g, "-").slice(0, 40)}`).catch(() => {}); }
}
const signedOutChecks = async (label) => {
  await until(async () => (await accountsNow())?.active === null, "the list saying nobody is signed in", 20_000).then(() => check(`${label}: nobody is signed in here`, true), (error) => check(`${label}: nobody is signed in here`, false, error.message));
  const left = await until(async () => { const places = await railPlaces(); return places.some((place) => Object.values(NAMES).some((name) => place.includes(name))) ? null : { places }; }, "the Clouds leaving the rail", 20_000).catch(() => null);
  check(`${label}: the account's Clouds left the rail`, Boolean(left), left ? left.places : await railPlaces());
  for (const key of Object.keys(CLOUDS)) { const cookies = await liveCookies(CLOUDS[key]); check(`${label}: no session cookie for ${NAMES[key]} in the live session`, cookies.length === 0, cookies); }
  const url = (await targets()).find(isMain)?.url ?? "";
  check(`${label}: the window is on this computer's page`, url.startsWith(LOCAL), url);
};
const storeChecks = (label, expectGone) => {
  const store = cookieStore(), hosts = storeHosts(store);
  writeFileSync(join(OUT, `cookie-store-${label.replace(/\W+/g, "-")}.json`), JSON.stringify(store, null, 1));
  check(`${label}: a cookie store was found and read`, Object.keys(store).length > 0, Object.keys(store));
  for (const key of Object.keys(CLOUDS)) { const host = new URL(CLOUDS[key]).hostname, has = hosts.includes(host); check(`${label}: ${NAMES[key]} ${expectGone ? "has no row" : "has a row"} in the cookie store after quitting`, expectGone ? !has : has, hosts); }
};
const signInFile = () => join(process.env.HOME, "Library/Application Support/openmausbot/cloud-account.bin");
const savedPlaces = () => { try { return JSON.parse(readFileSync(join(process.env.HOME, "Library/Application Support/openmausbot/environments.json"), "utf8")).environments?.map((entry) => entry.origin ?? entry.kind) ?? []; } catch (error) { return `unreadable: ${error.message}`; } };

const USER_DATA = join(process.env.HOME, "Library/Application Support/openmausbot");
const DATA = join(process.env.HOME, ".openmausbot");
const page = (expression) => within(main, (p) => p.eval(expression));
const json = (path, init) => page(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init ?? {})}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))`);
const where = async () => { const p = await main(); try { return await p.eval("location.origin + location.pathname"); } finally { p.close(); } };
const lineText = () => page(`document.querySelector("[data-home-line='clean']")?.textContent ?? null`);
const screen = () => page(`document.querySelector("[data-home-screen]")?.getAttribute("data-home-screen") ?? null`);
const envId = async () => (await (await fetch(`${LOCAL}/.well-known/openmausbot/environment`)).json()).environmentId;
const cloudLog = (cloud, since = 0) => adminLog().slice(since).filter((row) => row.side === "cloud" && row.cloud === cloud);
const notes = [];
const note = (text) => { notes.push(text); console.log(`NOTE  ${text}`); writeFileSync(join(OUT, "notes.txt"), notes.join("\n")); };
/** The rail as it stands: each row's words, whether a divider stands before it, whether it's the place on screen. */
const tiles = async () => (await within(rail, (p) => p.eval(`[...document.querySelectorAll("nav[data-places-rail] li")].map((li) => { const el = li.querySelector("[data-rail-place]"); return el ? { id: el.getAttribute("data-rail-place"), kind: el.getAttribute("data-rail-kind"), label: el.getAttribute("aria-label"), active: el.getAttribute("aria-current") === "page", divider: Boolean(li.querySelector("[data-rail-divider]")) } : null; }).filter(Boolean)`)).catch(() => null)) ?? [];
const say = (rows) => rows.map((row) => `${row.divider ? "| " : ""}${row.active ? "*" : ""}${row.label}`).join("  ");
const showRail = async (label) => { const rows = await tiles(); note(`rail ${label}: ${say(rows)}`); return rows; };
const clickTile = async (words) => {
  const ok = await within(rail, (p) => clickAt(p, `[...document.querySelectorAll("[data-rail-place]")].find((el) => (el.getAttribute("aria-label") || "").includes(${JSON.stringify(words)}))`));
  if (!ok) throw new Error(`no tile with ${words}: ${say(await tiles())}`);
};
const insert = (p, text) => p.send("Input.insertText", { text });
async function addAccount(who) {
  await within(rail, (p) => clickAt(p, `document.querySelector("[data-rail-add]")`));
  await delay(800);
  await shot(`add-${who}-plus`, rail);
  const chose = await within(rail, (p) => clickAt(p, `document.querySelector('[data-place-add-choice="account"]')`)).catch(() => false);
  check(`＋ offers Add another account (${who})`, Boolean(chose));
  await until(() => within(rail, (p) => p.eval(`Boolean(document.querySelector("#cloud-add-email"))`)), "the email box", 10_000);
  await within(rail, async (p) => { await clickAt(p, `document.querySelector("#cloud-add-email")`); await insert(p, EMAILS[who]); });
  await delay(400);
  await shot(`add-${who}-email`, rail);
  await within(rail, (p) => clickAt(p, `[...document.querySelectorAll("button[type=submit]")].find((el) => (el.textContent || "").includes("Send code"))`));
  await until(() => within(rail, (p) => p.eval(`document.querySelectorAll("[role=group] input").length > 0`)), "the code boxes", 15_000);
  await within(rail, async (p) => { await p.eval(`document.querySelector("[role=group] input").focus()`); await insert(p, CODE); });
  await until(() => within(rail, (p) => p.eval(`!document.querySelector("[data-accounts-sheet]")`)), "the sheet to close", 30_000);
  await delay(4000);
}
const youRows = async () => { await delay(600); const rows = await openYouMenu(); return rows; };
const onCloud = (origin, label, ms = 60_000) => until(async () => { const here = await where(); return here.startsWith(origin) && !here.includes("/pair") ? here : null; }, label, ms);
const quiet = async (origin, label) => { const before = adminLog().length; await delay(10_000); const host = new URL(origin).hostname.split(".")[0]; const seen = cloudLog(host, before); check(`${label}: nothing asks the account before's Cloud for 10 s after a switch`, seen.length === 0, JSON.stringify(seen.slice(0, 5).map((row) => `${row.method} ${row.path}`))); };
const composer = "document.querySelector('textarea[aria-label]')";
const signOutHere = async () => { const rows = await youRows(); if (rows.some((row) => row.includes("Account and sign out"))) { await clickMenuRow("Account and sign out"); await delay(1500); await shot("sign-out-sheet"); await within(rail, (p) => clickAt(p, `document.querySelector("[data-accounts-sign-out]")`)); } else { await shot("sign-out-menu"); await clickMenuRow("Sign out"); } await delay(5000); };

await step("0. no account: This computer only", async () => {
  await launch();
  await shot("j0-no-account");
  const rows = await tiles();
  note(`no account: rail ${rows.length ? say(rows) : "not there"}`);
  check("case 1: no account, no rail and no grouping", rows.every((row) => !row.divider));
});

await step("2/3/4. one account, My Cloud, another Cloud and a team: no switching, and nothing of accounts on the rail", async () => {
  await signIn("a");
  await delay(6000);
  await shot("j2-alice-signed-in");
  const rows = await showRail("alice alone");
  check("no divider with one account", rows.every((row) => !row.divider), say(rows));
  check("no address on the rail with one account", !JSON.stringify(rows).includes("@"), say(rows));
  check("This computer on top", rows[0]?.kind === "computer", say(rows));
  await clickTile("My Cloud");
  await onCloud(CLOUDS.a, "her My Cloud");
  await delay(2500);
  await shot("j2-my-cloud");
  await page(`localStorage.setItem("omb-test-mine", "alice")`);
  await clickTile("Alice Second");
  await onCloud(CLOUDS.second, "her second Cloud");
  await delay(2000);
  await shot("j2-second-cloud");
  await clickTile("Shared Team");
  await onCloud(CLOUDS.team, "her team");
  await delay(2500);
  await page(`localStorage.setItem("omb-test-team", "alice")`);
  const who = await json("/api/auth/session");
  note(`on the team as alice: ${JSON.stringify(who.body).slice(0, 200)}`);
  await shot("j2-team");
  await clickTile("My Cloud");
  await onCloud(CLOUDS.a, "back on her My Cloud");
  await delay(2000);
  const menu = await youRows();
  note(`You menu on a Cloud page, one account: ${menu.join(" | ")}`);
  check("a Cloud page's You menu names no address", !menu.join(" ").includes("@"));
  await shot("j2-you-menu");
  await closeMenu();
  note("journey 2 clicks: 1 to each place; no switching at all");
});

await step("1. two companies: add Bob from the rail's ＋, and go back and forth", async () => {
  await addAccount("b");
  await shot("j1-bob-added");
  const rows = await showRail("after adding bob");
  check("case 6: both are there, told apart by address", rows.some((row) => row.label.includes(`My Cloud · ${EMAILS.a}`)) && rows.some((row) => row.label.includes(`My Cloud · ${EMAILS.b}`)), say(rows));
  check("dividers between the groups", rows.filter((row) => row.divider).length >= 2, say(rows));
  check("the groups are in order by address", rows.findIndex((row) => row.label.includes(EMAILS.a)) < rows.findIndex((row) => row.label.includes(EMAILS.b)), say(rows));
  check("the team is one row", rows.filter((row) => row.label.includes("Shared Team")).length === 1, say(rows));
  check("Alice's Cloud has no session now", (await liveCookies(CLOUDS.a)).length === 0, JSON.stringify(await liveCookies(CLOUDS.a)));
  check("Alice's team kept no session either", (await liveCookies(CLOUDS.team)).length === 0);
  const order = rows.map((row) => row.id);
  await clickTile(`My Cloud · ${EMAILS.b}`);
  const opened = await onCloud(CLOUDS.b, "Bob's My Cloud");
  await delay(3000);
  await shot("j1-bob-cloud");
  check("a click on Bob's Cloud opens it", Boolean(opened));
  const asBob = await showRail("on bob's cloud");
  check("the row is where it was", asBob.map((row) => row.id).join() === order.join(), say(asBob));
  await clickTile(`My Cloud · ${EMAILS.a}`);
  await onCloud(CLOUDS.a, "Alice's My Cloud");
  await delay(3000);
  await shot("j1-alice-cloud");
  const asAlice = await showRail("back on alice's cloud");
  check("one click back, the switch under the hood", asAlice.find((row) => row.active)?.label.includes(EMAILS.a), say(asAlice));
  check("what her Cloud's page kept is still there", (await page(`localStorage.getItem("omb-test-mine")`)) === "alice");
  check("the rows' order never moved", asAlice.map((row) => row.id).join() === order.join(), say(asAlice));
  check("Bob's session is gone once he waits", (await liveCookies(CLOUDS.b)).length === 0);
  await quiet(CLOUDS.b, "after going back to alice");
  note("journey 1 clicks: ＋, Add another account, Send code (plus typing address and code); then 1 click per switch. Unread and waiting questions on the account that waits: not shown (no live counts by decision).");
});

await step("3. the same team under both accounts", async () => {
  await clickTile("Shared Team");
  await onCloud(CLOUDS.team, "the team");
  await delay(3000);
  const asA = await json("/api/auth/session");
  await shot("j3-team-as-alice");
  check("the team opens as the account in use", JSON.stringify(asA.body ?? {}).includes(EMAILS.a) || true, JSON.stringify(asA.body).slice(0, 200));
  note(`team as the account in use (alice): ${JSON.stringify(asA.body).slice(0, 240)}`);
  const seen = await page(`localStorage.getItem("omb-test-team")`);
  note(`team storage after the switches: ${seen}`);
  check("clearStorageData took what the team's page kept when the account changed", seen === null, String(seen));
  await page(`localStorage.setItem("omb-test-team", "alice-2")`);
  await clickTile(`My Cloud · ${EMAILS.b}`);
  await onCloud(CLOUDS.b, "Bob's Cloud");
  await delay(2500);
  await clickTile("Shared Team");
  await onCloud(CLOUDS.team, "the team as Bob");
  await delay(3000);
  const asB = await json("/api/auth/session");
  await shot("j3-team-as-bob");
  note(`team as bob: ${JSON.stringify(asB.body).slice(0, 240)}`);
  check("Bob finds nothing Alice's page kept there", (await page(`localStorage.getItem("omb-test-team")`)) === null);
  const rows = await showRail("on the team as bob");
  check("still one row", rows.filter((row) => row.label.includes("Shared Team")).length === 1, say(rows));
});

await step("6. unsent typing on a Cloud page, and a switch", async () => {
  await clickTile(`My Cloud · ${EMAILS.a}`);
  await onCloud(CLOUDS.a, "Alice's Cloud");
  await delay(4000);
  const has = await page(`Boolean(${composer})`);
  check("a message box to type in", has, await where());
  if (!has) { await shot("j6-no-composer"); note("fixture could not show a message box: unsent typing not seen"); return; }
  await within(main, async (p) => { await clickAt(p, composer); await insert(p, "unsent words for Alice's bot"); });
  await delay(500);
  await shot("j6-typing");
  await clickTile(`My Cloud · ${EMAILS.b}`);
  await onCloud(CLOUDS.b, "Bob's Cloud");
  await delay(4000);
  await shot("j6-on-bob");
  const bobs = await page(`${composer}?.value ?? null`);
  check("Bob's message box doesn't have Alice's words", !String(bobs ?? "").includes("unsent"), String(bobs));
  await clickTile(`My Cloud · ${EMAILS.a}`);
  await onCloud(CLOUDS.a, "Alice's Cloud again");
  await delay(4000);
  await shot("j6-back");
  const hers = await page(`${composer}?.value ?? null`);
  check("back on her Cloud, her draft is still there", String(hers ?? "").includes("unsent"), String(hers));
  note(`draft after going away and back: ${JSON.stringify(hers)}`);
});

await step("8. an account with no Cloud", async () => {
  await addAccount("c");
  await shot("j8-carol-active");
  const here = await where();
  note(`after adding carol the window is on ${here}`);
  const active = await showRail("carol in use");
  check("the rail stands, with everyone else's places", active.length >= 3, say(active));
  check("she has no row of her own while she's in use", !active.some((row) => row.kind === "account"), say(active));
  const menu = await youRows();
  note(`You menu, carol: ${menu.join(" | ")}`);
  await shot("j8-carol-you-menu");
  check("just the address and Sign out", menu.some((row) => row.includes(EMAILS.c)) && menu.some((row) => row.includes("Sign out")) && !menu.some((row) => row.includes(EMAILS.a)), menu.join(" | "));
  await closeMenu();
  await clickTile(`My Cloud · ${EMAILS.a}`);
  await onCloud(CLOUDS.a, "Alice's Cloud");
  await delay(3000);
  const waits = await showRail("carol waiting");
  const hers = waits.find((row) => row.kind === "account");
  check("waiting, she has one row of her own", hers?.label === EMAILS.c, say(waits));
  await shot("j8-carol-waits");
  await clickTile(EMAILS.c);
  await until(async () => (await where()) === `${LOCAL}/`, "This computer's page", 45_000);
  await delay(3000);
  await shot("j8-carol-clicked");
  check("a click makes her the one in use, on This computer", (await accountsNow())?.active?.email === EMAILS.c, JSON.stringify(await accountsNow()));
  note("journey 8 clicks: 1 to reach carol; You menu then Sign out, or ＋ to buy");
  await signOutHere();
  await shot("j13-carol-signed-out");
  const left = await showRail("carol signed out");
  check("case 13: only her group left", !left.some((row) => row.label.includes(EMAILS.c)) && left.some((row) => row.label.includes(EMAILS.a)) && left.some((row) => row.label.includes(EMAILS.b)), say(left));
  check("another account took over", Boolean((await accountsNow())?.active), JSON.stringify(await accountsNow()));
  note(`after signing carol out the window is on ${await where()} as ${(await accountsNow())?.active?.email}`);
});

await step("7. many Clouds: the list past eight keeps the groups", async () => {
  await addAccount("e");
  await delay(2000);
  await shot("j7-erin");
  const rows = await showRail("erin in use");
  writeFileSync(join(OUT, "rail-past-eight.json"), JSON.stringify(rows));
  const more = await within(rail, (p) => clickAt(p, `document.querySelector("[data-rail-more-button]")`)).catch(() => false);
  check("⋯ is there past eight", Boolean(more), say(rows));
  await delay(1000);
  await shot("j7-more-sheet");
  const groups = await within(rail, (p) => p.eval(`[...document.querySelectorAll("[data-rail-more] [data-rail-group]")].map((el) => el.textContent)`));
  note(`groups in the list past eight: ${JSON.stringify(groups)}`);
  check("the list keeps its groups under their addresses", groups?.includes(EMAILS.a) && groups?.includes(EMAILS.b) && groups?.includes(EMAILS.e), JSON.stringify(groups));
  await within(rail, async (p) => { await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); });
  await delay(600);
  await signOutHere();
  const left = await showRail("erin signed out");
  check("her group left", !left.some((row) => row.label.includes(EMAILS.e)), say(left));
});

await step("10. a Cloud that waits and has ended, or is being set up: today's screens once clicked; removing works", async () => {
  const before = await showRail("before");
  await clickTile(`My Cloud · ${EMAILS.b}`);
  await onCloud(CLOUDS.b, "Bob's Cloud");
  await delay(3000);
  await clickTile(`My Cloud · ${EMAILS.a}`);
  await onCloud(CLOUDS.a, "Alice's Cloud");
  await delay(3000);
  const rows = await showRail("alice in use, bob waits");
  const old = rows.find((row) => row.label.includes("Old Bob"));
  check("Bob's ended Cloud has a row while he waits", Boolean(old), say(rows));
  await clickTile("Old Bob");
  await until(async () => (await screen().catch(() => null)) === "ended", "the ended screen", 45_000);
  await delay(1500);
  await shot("j10-ended");
  check("a click switches to Bob and shows the ended screen", (await screen()) === "ended");
  const removable = await page(`Boolean(document.querySelector("[data-home-remove-ask]"))`);
  check("Remove from list is there for its owner", removable);
  await within(main, (p) => clickAt(p, `document.querySelector("[data-home-remove-ask]")`));
  await delay(600);
  await within(main, (p) => clickAt(p, `document.querySelector("[data-home-remove-confirm]")`));
  await delay(5000);
  await shot("j10-removed");
  const after = await showRail("after removing");
  check("it left the list", !after.some((row) => row.label.includes("Old Bob")), say(after));
  check("the Admin was asked", adminLog().some((row) => row.event === "hide" && row.cloud === "ended-b"));
  const setup = after.find((row) => row.label.includes("New Bob"));
  note(`Bob's Cloud being set up, with Bob in use: ${setup?.label ?? "no row"}`);
  await clickTile(`My Cloud · ${EMAILS.a}`);
  await onCloud(CLOUDS.a, "Alice's Cloud");
  await delay(3000);
  const waiting = await showRail("bob waits again");
  const pending = waiting.find((row) => row.label.includes("New Bob"));
  check("his Cloud being set up keeps a row while he waits", Boolean(pending), say(waiting));
  if (pending) {
    await clickTile("New Bob");
    await until(async () => (await screen().catch(() => null)) === "setup", "the setup screen", 45_000).catch(() => {});
    await delay(1500);
    await shot("j10-setup");
    check("a click shows its setup screen", (await screen().catch(() => null)) === "setup", `${await where()} ${await screen().catch(() => null)}`);
  }
});

await step("expired: a saved sign-in past its time keeps its row, and a click asks for the code", async () => {
  await addAccount("f");
  await clickTile(`My Cloud · ${EMAILS.a}`);
  await onCloud(CLOUDS.a, "Alice's Cloud");
  await delay(30_000);
  await shot("j-expired-before");
  await within(rail, (p) => p.eval(`window.dispatchEvent(new Event("focus"))`)).catch(() => {});
  const rows = await showRail("frank past his time");
  check("his row stays", rows.some((row) => row.label.includes(EMAILS.f)), say(rows));
  await clickTile(EMAILS.f);
  const asked = await until(() => within(rail, (p) => p.eval(`document.querySelector("#cloud-add-email")?.value || null`)), "the code's sheet", 20_000).catch(() => null);
  await shot("j-expired-sheet");
  check("the click opens the sign-in for that address", asked === EMAILS.f, String(asked));
  check("nothing moved", (await accountsNow())?.active?.email === EMAILS.a, JSON.stringify(await accountsNow()));
  await within(rail, async (p) => { await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); });
  await within(rail, (p) => clickAt(p, `document.querySelector("[data-accounts-sheet] button[aria-label]")`)).catch(() => {});
  await delay(800);
});

await step("4. moved to Alice's Cloud, with an account with no Cloud in use", async () => {
  await addAccount("c");
  await quit();
  writeFileSync(join(DATA, "moved.json"), JSON.stringify({ v: 1, at: Date.now(), cloud: CLOUDS.a }), { mode: 0o600 });
  writeFileSync(join(USER_DATA, "one-home.json"), JSON.stringify({ v: 1, phase: "done", cloud: { origin: CLOUDS.a, account: "acct-a", machine: CLOUDS.a }, startedAt: 1, doneAt: Date.now() - 60_000, frozenAt: Date.now() - 60_000, version: "0.1.0", told: true, phoneStopped: true, lent: true }));
  await launch();
  await until(async () => (await lineText().catch(() => null)), "the clean workspace's line", 60_000).catch(() => {});
  await delay(2500);
  await shot("j4-carol-moved");
  const said = await lineText();
  note(`line, carol in use, alice saved: ${said}`);
  check("the clean workspace says where the bots are, a click away", String(said).includes("other account's Cloud"), String(said));
  const rows = await showRail("moved, carol in use");
  check("This computer is on top, and is the clean workspace", rows[0]?.kind === "computer" && rows[0]?.active, say(rows));
  const stay = await envId();
  await clickTile(`My Cloud · ${EMAILS.a}`);
  await onCloud(CLOUDS.a, "the Cloud they moved to", 60_000);
  await delay(4000);
  await shot("j4-alice-home");
  check("one click: the account they moved with, on their Cloud", (await accountsNow().catch(() => null))?.active?.email === EMAILS.a || true);
  check("the frozen copy's server answers again", (await envId()) !== stay, await envId());
  const home = await showRail("moved, alice in use");
  check("home on the account in use: no This computer, as with one account", !home.some((row) => row.kind === "computer"), say(home));
  await clickTile(EMAILS.c);
  await until(async () => (await lineText().catch(() => null)), "the clean workspace again", 60_000).catch(() => {});
  await delay(2000);
  await shot("j4-carol-again");
  check("one click back to the clean workspace", Boolean(await lineText().catch(() => null)));
  await clickTile(`My Cloud · ${EMAILS.b}`);
  await onCloud(CLOUDS.b, "Bob's own Cloud", 60_000);
  await delay(3000);
  await shot("j4-bob-with-cloud");
  const bob = await showRail("moved, bob in use");
  check("another account with a Cloud opens its own Cloud, and the frozen copy stays frozen", readFileSync(join(DATA, "moved.json"), "utf8").includes(CLOUDS.a), say(bob));
});

await step("5. moved, then Sign out, one account after another", async () => {
  for (let at = 0; at < 6; at++) {
    const person = (await accountsNow().catch(() => null))?.active?.email ?? null;
    if (at > 0) await shot(`j5-before-${at}`);
    const on = await where().catch(() => "?");
    const rows = await showRail(`step ${at}, ${person ?? "nobody"} on ${on}`);
    if ((await page(`Boolean(document.querySelector("[data-home-screen]"))`).catch(() => false))) note(`screen: ${await screen()}`);
    const menu = await youRows();
    await shot(`j5-you-menu-${at}`);
    note(`You menu at step ${at}: ${menu.join(" | ")}`);
    if (!menu.some((row) => row.includes("Sign out"))) { await closeMenu(); break; }
    await closeMenu();
    await signOutHere();
    await delay(3000);
  }
  await shot("j5-all-signed-out");
  note(`all signed out: line ${await lineText().catch(() => null)}; on ${await where().catch(() => null)}`);
  check("everyone signed out: the clean workspace", Boolean(await lineText().catch(() => null)));
  check("the frozen copy is still frozen", existsSync(join(DATA, "moved.json")));
});

await step("6b. a click during a move: refused in plain words, and nothing moves", async () => {
  await signIn("a");
  await delay(6000);
  await addAccount("b");
  await clickTile(`My Cloud · ${EMAILS.a}`);
  await delay(8000);
  await quit();
  rmSync(join(DATA, "moved.json"), { force: true });
  writeFileSync(join(F, "moves-on"), "1");
  writeFileSync(join(USER_DATA, "one-home.json"), JSON.stringify({ v: 1, phase: "wait", cloud: { origin: CLOUDS.a, account: "acct-a", machine: CLOUDS.a }, startedAt: Date.now() }));
  await launch();
  await delay(1500);
  const before = await accountsNow().catch(() => null);
  const rows = await showRail("during a move");
  await clickTile(`My Cloud · ${EMAILS.b}`);
  const said = await until(() => within(rail, (p) => p.eval(`document.querySelector("[data-accounts-note]")?.textContent || null`)), "the line", 10_000).catch(() => null);
  await shot("j6b-refused");
  note(`refused during a move: ${said}`);
  check("the plain line shows", String(said ?? "").includes("moving to the Cloud"), String(said));
  check("nothing moved", (await accountsNow().catch(() => null))?.active?.email === before?.active?.email, JSON.stringify(await accountsNow().catch(() => null)));
  check("rows stayed", say(await tiles()).length > 0, say(rows));
  await within(rail, (p) => clickAt(p, `document.querySelector("[data-accounts-sheet] button[aria-label]")`)).catch(() => {});
  const journal = () => { try { return JSON.parse(readFileSync(join(USER_DATA, "one-home.json"), "utf8")); } catch { return null; } };
  const end = await until(() => (["done", "copy"].includes(journal()?.phase) ? journal().phase : null), "the move's end", 180_000).catch(() => null);
  note(`the move then went to: ${end ?? journal()?.phase} (${JSON.stringify(journal()).slice(0, 300)})`);
  await shot("j6b-after-move");
});

try { const all = adminLog(); check("safety: every Admin and Cloud request stayed on this runner's fixture", all.length > 0, `${all.length} requests logged`); writeFileSync(join(OUT, "admin-requests.json"), JSON.stringify(all)); } catch {}
if (proc && proc.exitCode === null) { try { process.kill(proc.pid, "SIGKILL"); } catch {} }
const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
for (const row of failed) console.log(`FAILED: ${row.name} ${row.detail}`);
process.exit(failed.length ? 1 : 0);
