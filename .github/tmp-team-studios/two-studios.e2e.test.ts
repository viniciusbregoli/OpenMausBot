// A one-off walkthrough, not a test of the product's promises: one Team Cloud, the owner's two studios, and what each hand-off really does.
// Records facts in STUDIOS_OUT; asserts nothing beyond the fixture working. The engine is the synthetic Claude CLI.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const }, MEMBER = { email: "mara@acme.test", role: "member" as const };
const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";`;
const OUT = process.env.STUDIOS_OUT ?? "/tmp/studios.json";
const facts: Record<string, unknown> = {};
const record = (name: string, value: unknown) => { facts[name] = value; writeFileSync(OUT, JSON.stringify(facts, null, 1)); console.log(`\n### ${name}\n${JSON.stringify(value).slice(0, 1500)}`); };
let fx: CloudSendFixture, team: CloudTeamFixture, owner = "", member = "";
type Bot = { id: string; name: string; threadId: string; mainThreadId?: string; section?: string; visibility?: unknown; access?: unknown; yourAccess?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (done: () => Promise<boolean> | boolean, ms = 60_000) => { const end = Date.now() + ms; while (!(await done())) { if (Date.now() > end) return false; await sleep(150); } return true; };
const script = (calls: unknown[] | null) => { const file = join(team.home, "tool-calls.json"); if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true }); };
const dump = () => { try { return JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as { systemPrompt: string; prompt: unknown }; } catch { return null; } };
const bots = async (token: string) => (await team.as(token, "GET", "/api/bots")).body.bots as Bot[];
const idle = async () => (await bots(owner)).every((bot) => !(bot as { busy?: boolean }).busy && !(bot as { activity?: string }).activity);
const rows = async (token: string, threadId: string) => ((await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Array<{ id: string; kind: string; text?: string; tool?: { name: string; ok?: boolean; output?: string }; sender?: unknown }>;
const toolRows = async (token: string, threadId: string) => (await rows(token, threadId)).filter((row) => row.kind === "activity" && row.tool).map((row) => ({ name: row.tool!.name, ok: row.tool!.ok, output: row.tool!.output?.slice(0, 900) }));
const say = async (token: string, botId: string, threadId: string, text: string, calls: unknown[] | null) => {
  script(calls); rmSync(join(team.home, "dump.json"), { force: true });
  const before = (await rows(token, threadId)).length;
  const sent = await team.as(token, "POST", `/api/bots/${botId}/messages`, { text, threadId });
  if (sent.status !== 202) return { status: sent.status, body: sent.body };
  await until(async () => (await idle()) && (await rows(token, threadId)).length >= before + 2 && existsSync(join(team.home, "dump.json")), 60_000);
  await sleep(600);
  return { status: 202, tools: (await toolRows(token, threadId)).slice(-(calls?.length ?? 0) || -1), last: (await rows(token, threadId)).at(-1)?.text?.slice(0, 300) };
};
/** A routine as the person's app makes it, run now as Run now does. */
const routineRun = async (token: string, botId: string, name: string, calls: unknown[] | null) => {
  const made = await team.as(token, "POST", "/api/routines", { name, prompt: "Send today's numbers to Bookkeeping.", botId, schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } });
  if (made.status !== 201) return { madeStatus: made.status, made: made.body };
  script(calls); rmSync(join(team.home, "dump.json"), { force: true });
  const ran = await team.as(token, "POST", `/api/routines/${made.body.routine.id}/run`);
  await until(async () => existsSync(join(team.home, "dump.json")) && await idle(), 60_000);
  await sleep(800);
  const runs = await team.as(token, "GET", `/api/routines/${made.body.routine.id}/runs`);
  const run = (runs.body.runs ?? [])[0] ?? ran.body.run ?? null;
  const threadId = run?.threadId ?? ran.body.threadId ?? made.body.routine.threadId;
  return { routine: made.body.routine.id, runStatus: ran.status, ran: JSON.stringify(ran.body).slice(0, 300), threadId, tools: threadId ? await toolRows(token, threadId) : null, reply: threadId ? (await rows(token, threadId)).at(-1)?.text?.slice(0, 300) : null, dumped: dump()?.systemPrompt?.length ?? null };
};
const handOff = (to: string, extra: Record<string, unknown> = {}) => ({ name: "coordinate_bots", server: "agents", input: { bot_ids: [to], message: "Rooms 12, Staff hours 86, Sales 4200.", ...extra } });

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!; member = (await team.pair(MEMBER)).token!;
}, 180_000);
afterAll(async () => { await fx?.close(); });

it("walks the two studios", async () => {
  const make = async (name: string, section: string, access?: unknown) => {
    const made = await team.as(owner, "POST", "/api/bots", { name, section });
    if (made.status !== 201) throw new Error(`${name}: ${made.status} ${JSON.stringify(made.body)}`);
    if (access) { const set = await team.as(owner, "PUT", `/api/bots/${made.body.bot.id}/access`, access); if (set.status !== 200) throw new Error(`${name} access: ${set.status} ${JSON.stringify(set.body)}`); }
    return made.body.bot as Bot;
  };
  const ONLY_OWNER = { everyone: "none", people: {} }, B = { everyone: "none", people: { [MEMBER.email]: "chat" } };
  const bookkeeping = await make("Bookkeeping", "Studio A", ONLY_OWNER), rooms = await make("Rooms", "Studio B", B), hours = await make("Staff Hours", "Studio B", B), sales = await make("Sales", "Studio B", B);
  const copy = async (token: string, id: string) => (await bots(token)).find((bot) => bot.id === id);
  record("setup: as stored (owner's copy)", await Promise.all([bookkeeping, rooms, hours, sales].map(async ({ id }) => { const b = await copy(owner, id); return { name: b?.name, section: b?.section, access: b?.access, visibility: b?.visibility }; })));
  record("the bots the member lists", (await bots(member)).map((bot) => ({ name: bot.name, section: bot.section, yourAccess: bot.yourAccess, private: (bot as { defaultBot?: unknown }).defaultBot ? "own MausBot" : undefined })));

  // --- who a B bot can reach at all
  record("Rooms' list_bots, as the bot sees it", await say(owner, rooms.id, rooms.mainThreadId ?? rooms.threadId, "Who can you reach?", [{ name: "list_bots", server: "agents", input: {} }]));
  // --- the control: inside Studio B
  const inB = await routineRun(owner, rooms.id, "B to B", [handOff(hours.id)]);
  record("CONTROL owner's routine on Rooms -> Staff Hours (same people)", inB);
  await until(idle, 30_000);
  // --- the hand-off itself
  const bookkeepingBefore = (await rows(owner, bookkeeping.mainThreadId ?? bookkeeping.threadId)).length;
  record("OWNER's routine on Rooms -> Bookkeeping by id", await routineRun(owner, rooms.id, "Evening numbers", [handOff(bookkeeping.id)]));
  record("OWNER's routine on Rooms -> Bookkeeping by name", await routineRun(owner, rooms.id, "Evening numbers by name", [handOff("Bookkeeping")]));
  record("OWNER's routine, one-way reply:none -> Bookkeeping", await routineRun(owner, rooms.id, "Evening one way", [handOff(bookkeeping.id, { reply: "none" })]));
  record("MEMBER's routine on Rooms -> Bookkeeping by id", await routineRun(member, rooms.id, "Mara evening numbers", [handOff(bookkeeping.id)]));
  record("MEMBER's routine on Rooms -> Bookkeeping by name", await routineRun(member, rooms.id, "Mara evening by name", [handOff("Bookkeeping")]));
  const mineThread = (await team.as(member, "POST", `/api/bots/${rooms.id}/tasks`, { title: "My numbers" })).body.task?.threadId;
  record("MEMBER's own private chat with Rooms -> Bookkeeping by name", await say(member, rooms.id, mineThread, "Send this to Bookkeeping", [handOff("Bookkeeping")]));
  record("MEMBER in Rooms' main chat -> Bookkeeping by name", await say(member, rooms.id, rooms.mainThreadId ?? rooms.threadId, "Send this to Bookkeeping", [handOff("Bookkeeping")]));
  const bookkeepingBot = await copy(owner, bookkeeping.id);
  record("Bookkeeping afterwards, as the owner sees it: did anything arrive?", { before: bookkeepingBefore, now: (await rows(owner, bookkeeping.mainThreadId ?? bookkeeping.threadId)).length, threads: ((bookkeepingBot as unknown as { tasks?: Array<{ title?: string; threadId: string }> })?.tasks ?? []).map((task) => task.title) });

  // --- can the member see or reach Bookkeeping or what it got?
  const bb = bookkeeping.mainThreadId ?? bookkeeping.threadId;
  const statuses: Record<string, number> = {};
  for (const [method, path, body] of [["GET", `/api/threads/${bb}/messages`], ["POST", `/api/bots/${bookkeeping.id}/messages`, { text: "Hi", threadId: bb }], ["POST", `/api/bots/${bookkeeping.id}/tasks`, { title: "Mine" }], ["PUT", `/api/bots/${bookkeeping.id}/access`, { everyone: "chat", people: {} }],
    ["POST", "/api/routines", { name: "Peek", prompt: "Hi", botId: bookkeeping.id, schedule: { type: "once", at: Date.now() + 86_400_000 } }], ["POST", "/api/groups", { memberIds: [rooms.id, bookkeeping.id], name: "Mixed", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } }], ["GET", `/api/bots/${bookkeeping.id}/memory/mine`], ["PATCH", `/api/bots/${bookkeeping.id}`, { color: "teal" }]] as Array<[string, string, unknown?]>) statuses[`${method} ${path.replaceAll(bookkeeping.id, "<bookkeeping>").replaceAll(bb, "<its main chat>")}`] = (await team.as(member, method, path, body)).status;
  record("member against Bookkeeping's routes", statuses);
  const everywhere = await Promise.all(["/api/routines", "/api/today", "/api/needs-you", "/api/inbox", "/api/team/people", "/api/search?q=Bookkeeping", "/api/usage"].map(async (path) => { const r = await team.as(member, "GET", path); return { path, status: r.status, names: JSON.stringify(r.body).includes("Bookkeeping") }; }));
  record("does the name Bookkeeping appear in what the member's app reads?", everywhere);
  const memberThreadTexts = JSON.stringify(await rows(member, mineThread)) + JSON.stringify(await rows(member, rooms.mainThreadId ?? rooms.threadId));
  record("does the name reach the member through a refused hand-off?", { inMemberPrivateChat: /Bookkeeping/.test(JSON.stringify(await rows(member, mineThread))), inMain: /Bookkeeping/.test(JSON.stringify(await rows(member, rooms.mainThreadId ?? rooms.threadId))), excerpt: (memberThreadTexts.match(/.{0,120}isn't shared here.{0,120}/) ?? [null])[0] });
  // A room with both, as the owner.
  const mixed = await team.as(owner, "POST", "/api/groups", { memberIds: [rooms.id, bookkeeping.id], name: "Numbers", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  record("owner: a group chat with Rooms and Bookkeeping", { status: mixed.status, body: JSON.stringify(mixed.body).slice(0, 400) });

  // --- what works instead
  const ownerBots = await bots(owner), ownMausBot = ownerBots.find((bot) => (bot as { defaultBot?: unknown }).defaultBot);
  record("owner's own MausBot", { name: ownMausBot?.name, visibility: ownMausBot?.visibility, section: ownMausBot?.section });
  if (ownMausBot) record("owner's own MausBot -> Bookkeeping", await say(owner, ownMausBot.id, ownMausBot.mainThreadId ?? ownMausBot.threadId, "Pass this to Bookkeeping", [handOff(bookkeeping.id)]));
  await until(idle, 30_000);
  record("Bookkeeping after MausBot's hand-off", { rows: (await rows(owner, bb)).length, threads: (((await copy(owner, bookkeeping.id)) as unknown as { tasks?: Array<{ title?: string }> })?.tasks ?? []).map((task) => task.title) });
  const asPerson = { name: "message_person", server: "agents", input: { to: OWNER.email, message: "Rooms 12, Staff hours 86, Sales 4200." } };
  record("owner's routine on Rooms: message_person to the owner", await routineRun(owner, rooms.id, "Tell Olive", [asPerson]));
  record("member's routine on Rooms: message_person to the owner", await routineRun(member, rooms.id, "Mara tells Olive", [asPerson]));
  await sleep(1500);
  const inbox = await team.as(owner, "GET", "/api/inbox");
  record("owner's inbox", { status: inbox.status, rows: (inbox.body.rows ?? []).slice(0, 8).map((row: Record<string, unknown>) => ({ tab: row.tab, from: row.from ?? row.fromName, text: String(row.text ?? row.excerpt ?? "").slice(0, 120), kind: row.kind })) });
  // Does the routine's own report reach anyone's inbox, and who may read a run's chat?
  const ownerRoutine = facts["OWNER's routine on Rooms -> Bookkeeping by id"] as { threadId?: string };
  const memberRoutine = facts["MEMBER's routine on Rooms -> Bookkeeping by id"] as { threadId?: string };
  record("who may read a routine's run chat", { ownerRun: { owner: (await team.as(owner, "GET", `/api/threads/${ownerRoutine.threadId}/messages`)).status, member: (await team.as(member, "GET", `/api/threads/${ownerRoutine.threadId}/messages`)).status }, memberRun: { owner: (await team.as(owner, "GET", `/api/threads/${memberRoutine.threadId}/messages`)).status, member: (await team.as(member, "GET", `/api/threads/${memberRoutine.threadId}/messages`)).status } });

  // --- where the numbers can come from: what the member typed, in each kind of chat, and what a routine's turn reads
  const remember = (text: string) => ({ name: "memory_update", server: "agents", input: { action: "append", text } });
  const main = rooms.mainThreadId ?? rooms.threadId;
  await say(member, rooms.id, main, "Rooms today: 12 MAINCHATNUMBER", [remember("Rooms today: 12 MAINCHATNUMBER")]);
  await say(member, rooms.id, mineThread, "Rooms today: 13 PRIVATECHATNUMBER", [remember("Rooms today: 13 PRIVATECHATNUMBER")]);
  await until(idle, 30_000);
  const routineSees = await routineRun(owner, rooms.id, "Reads the numbers", null);
  const seen = dump();
  record("what an owner's routine turn on Rooms is given", { routine: routineSees.runStatus, systemHasMain: seen?.systemPrompt?.includes("MAINCHATNUMBER") ?? null, systemHasPrivate: seen?.systemPrompt?.includes("PRIVATECHATNUMBER") ?? null, promptHasMain: JSON.stringify(seen?.prompt ?? "").includes("MAINCHATNUMBER"), promptHasPrivate: JSON.stringify(seen?.prompt ?? "").includes("PRIVATECHATNUMBER") });
  const memberRoutineSees = await routineRun(member, rooms.id, "Mara reads the numbers", null);
  const seenM = dump();
  record("what a member's routine turn on Rooms is given", { routine: memberRoutineSees.runStatus, systemHasMain: seenM?.systemPrompt?.includes("MAINCHATNUMBER") ?? null, systemHasPrivate: seenM?.systemPrompt?.includes("PRIVATECHATNUMBER") ?? null });
  for (const [label, threadId] of [["owner's routine", routineSees.threadId], ["member's routine", memberRoutineSees.threadId]] as const) {
    if (!threadId) continue;
    const capability = await team.capability(rooms.id, threadId).catch(() => null);
    if (!capability) { record(`session_search from ${label}`, "no capability"); continue; }
    const search = async (q: string) => { const r = await fetch(`${team.base}/api/internal/session-search?query=${q}&q=${q}`, { headers: { authorization: `Bearer ${capability}` } }); return { status: r.status, hit: (await r.text()).includes(q) }; };
    record(`session_search from ${label}`, { main: await search("MAINCHATNUMBER"), private: await search("PRIVATECHATNUMBER") });
  }
  record("the main chat as the owner reads it, the numbers line", (await rows(owner, main)).filter((row) => row.text?.includes("MAINCHATNUMBER")).map((row) => row.text?.slice(0, 80)));
  record("the member's private chat as the owner reads it", (await team.as(owner, "GET", `/api/threads/${mineThread}/messages`)).status);

  // --- the ways it would work: shared with the same people
  const widen = await team.as(owner, "PUT", `/api/bots/${bookkeeping.id}/access`, { everyone: "none", people: { [MEMBER.email]: "view" } });
  record("Bookkeeping shared with the member at Can view: does the hand-off work then?", { set: widen.status, memberLists: (await bots(member)).some((bot) => bot.name === "Bookkeeping"), run: await routineRun(owner, rooms.id, "Evening, wider", [handOff(bookkeeping.id)]) });
  await team.as(owner, "PUT", `/api/bots/${bookkeeping.id}/access`, ONLY_OWNER);
  const narrow = await team.as(owner, "PUT", `/api/bots/${rooms.id}/access`, ONLY_OWNER);
  record("Rooms narrowed to the owner too: hand-off then?", { set: narrow.status, run: await routineRun(owner, rooms.id, "Evening, narrow", [handOff(bookkeeping.id)]), memberStillLists: (await bots(member)).some((bot) => bot.name === "Rooms") });
}, 420_000);
