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
const idle = async () => (await bots(owner)).every((bot) => !(bot as { busy?: boolean }).busy && (bot as { activity?: string }).activity !== "working");
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
  const runId = ran.body.run?.id;
  let run: Record<string, unknown> | undefined;
  await until(async () => {
    run = ((await team.as(token, "GET", "/api/routines")).body.runs as Array<Record<string, unknown>> | undefined)?.find((candidate) => candidate.id === runId);
    return Boolean(run) && ["completed", "failed", "error", "cancelled", "waiting"].includes(String(run!.status));
  }, 90_000);
  await sleep(500);
  const threadId = run?.threadId as string | undefined;
  return { routine: made.body.routine.id, runStatus: ran.status, status: run?.status, resultSummary: String(run?.summary ?? run?.result ?? run?.detail ?? "").slice(0, 300), threadId, runBot: run?.botId, tools: threadId ? await toolRows(token, threadId) : null, reply: threadId ? (await rows(token, threadId)).at(-1)?.text?.slice(0, 300) : null, promptHead: JSON.stringify(dump()?.prompt ?? "").slice(0, 400) };
};
const handOff = (to: string, extra: Record<string, unknown> = {}) => ({ name: "coordinate_bots", server: "agents", input: { bot_ids: [to], message: "Rooms 12, Staff hours 86, Sales 4200.", ...extra } });

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!; member = (await team.pair(MEMBER)).token!;
}, 180_000);
afterAll(async () => { await fx?.close(); });

it("the rest of the two studios", async () => {
  const make = async (token: string, name: string, section: string, access?: unknown) => {
    const made = await team.as(token, "POST", "/api/bots", { name, section });
    if (made.status !== 201) return { error: made.status, body: made.body } as unknown as Bot;
    if (access) { const set = await team.as(token, "PUT", `/api/bots/${made.body.bot.id}/access`, access); if (set.status !== 200) throw new Error(`${name} access: ${set.status} ${JSON.stringify(set.body)}`); }
    return made.body.bot as Bot;
  };
  const ONLY_OWNER = { everyone: "none", people: {} }, B = { everyone: "none", people: { [MEMBER.email]: "chat" } };
  const copy = async (token: string, id: string) => (await bots(token)).find((bot) => bot.id === id);
  // The moment before the owner restricts it.
  const bookkeeping = await make(owner, "Bookkeeping", "Studio A");
  record("right after New bot, before Share: does the member list it?", { memberLists: Boolean(await copy(member, bookkeeping.id)), yourAccess: (await copy(member, bookkeeping.id))?.yourAccess, ownerCopy: (await copy(owner, bookkeeping.id))?.access });
  await team.as(owner, "PUT", `/api/bots/${bookkeeping.id}/access`, ONLY_OWNER);
  const rooms = await make(owner, "Rooms", "Studio B", B), hours = await make(owner, "Staff Hours", "Studio B", B), sales = await make(owner, "Sales", "Studio B", B);
  // What a member's own new bot is.
  const mine = await make(member, "Marketing Helper", "");
  record("a bot the member makes", { status: (mine as unknown as { error?: number }).error ?? 201, body: JSON.stringify(mine).slice(0, 300), ownerSees: Boolean(mine.id && await copy(owner, mine.id)), access: mine.id ? (await copy(owner, mine.id))?.access : null, visibility: mine.id ? (await copy(owner, mine.id))?.visibility : null });
  // Whose MausBot is whose, and what an admin can do with someone else's.
  const all = await bots(owner), people = (bot: Bot) => JSON.stringify(bot.visibility ?? "");
  const defaults = all.filter((bot) => (bot as { defaultBot?: unknown }).defaultBot);
  record("every MausBot the owner's list has", defaults.map((bot) => ({ name: bot.name, visibility: bot.visibility, yourAccess: bot.yourAccess, hidden: (bot as { sidebarHidden?: unknown }).sidebarHidden })));
  const ownMaus = defaults.find((bot) => people(bot).includes(OWNER.email)), maraMaus = (await bots(member)).find((bot) => (bot as { defaultBot?: unknown }).defaultBot)!;
  const maraMain = maraMaus.mainThreadId ?? maraMaus.threadId;
  await say(member, maraMaus.id, maraMain, "My salary is MARAPRIVATE", null);
  const maraThreads = ((await copy(member, maraMaus.id)) as unknown as { tasks?: Array<{ threadId: string; private?: boolean; title?: string; inbox?: boolean }> }).tasks;
  record("the member's MausBot's chats, as the member sees them", maraThreads?.map((task) => ({ title: task.title, private: task.private, inbox: task.inbox, isMain: task.threadId === maraMain })));
  const peek = await team.as(owner, "GET", `/api/threads/${maraMain}/messages`);
  record("the owner reading the member's MausBot's main chat", { status: peek.status, seesWords: JSON.stringify(peek.body).includes("MARAPRIVATE") });
  const poke = await team.as(owner, "POST", `/api/bots/${maraMaus.id}/messages`, { text: "Hello from the owner", threadId: maraMain });
  record("the owner writing in it", { status: poke.status, body: JSON.stringify(poke.body).slice(0, 200) });
  // The owner's own MausBot is the same audience as Bookkeeping.
  if (ownMaus) {
    const before = ((await copy(owner, bookkeeping.id)) as unknown as { tasks?: unknown[] }).tasks?.length;
    record("owner's own MausBot -> Bookkeeping", await say(owner, ownMaus.id, ownMaus.mainThreadId ?? ownMaus.threadId, "Pass this to Bookkeeping", [handOff(bookkeeping.id)]));
    await until(idle, 30_000); await sleep(1500);
    const bk = (await copy(owner, bookkeeping.id)) as unknown as { tasks?: Array<{ title?: string; threadId: string }> };
    record("Bookkeeping after it", { before, now: bk.tasks?.length, lines: bk.tasks ? await Promise.all(bk.tasks.map(async (task) => ({ title: task.title, last: (await rows(owner, task.threadId)).at(-2)?.text?.slice(0, 160) }))) : null });
    record("a routine on the owner's own MausBot -> Bookkeeping", await routineRun(owner, ownMaus.id, "Evening relay", [handOff(bookkeeping.id, { reply: "none" })]));
    record("and can MausBot read what reached the owner's inbox?", { inboxTools: "message_person lines land in this bot's inbox chat", prompt: JSON.stringify(dump()?.prompt ?? "").includes("MARA") });
  }
  // A place in Studio B for numbers: one group chat with the three bots, made by each of them.
  const groupBody = { memberIds: [rooms.id, hours.id, sales.id], name: "Studio B numbers", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } };
  const byMember = await team.as(member, "POST", "/api/groups", groupBody); const byOwner = await team.as(owner, "POST", "/api/groups", { ...groupBody, name: "Studio B numbers 2" });
  record("a group chat of the three Studio B bots", { member: byMember.status, memberBody: JSON.stringify(byMember.body).slice(0, 240), owner: byOwner.status });
  const mixedAsMember = await team.as(member, "POST", "/api/groups", { memberIds: [rooms.id, bookkeeping.id], name: "Mixed", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  record("the member naming Bookkeeping in a group chat", { status: mixedAsMember.status, body: JSON.stringify(mixedAsMember.body).slice(0, 300) });
  // A person's level on Bookkeeping as an Admin of the team: what making the Studio B manager an Admin does.
  const adminToken = (await team.pair({ email: "ben@acme.test", role: "admin" as const })).token!;
  const asAdmin = await copy(adminToken, bookkeeping.id);
  record("a team Admin and Bookkeeping", { lists: Boolean(asAdmin), yourAccess: asAdmin?.yourAccess, readsMain: (await team.as(adminToken, "GET", `/api/threads/${bookkeeping.mainThreadId ?? bookkeeping.threadId}/messages`)).status });
  // Who is on the Add people list: only those who opened the team.
  const peopleBefore = await team.as(owner, "GET", "/api/team/people");
  const addStranger = await team.as(owner, "PUT", `/api/bots/${sales.id}/access`, { everyone: "none", people: { [MEMBER.email]: "chat", "accepted-but-never-opened@acme.test": "chat" } });
  record("sharing with someone who joined but never opened the team", { list: (peopleBefore.body.people ?? []).map((one: { email: string }) => one.email), status: addStranger.status, body: JSON.stringify(addStranger.body).slice(0, 200) });
}, 600_000);
