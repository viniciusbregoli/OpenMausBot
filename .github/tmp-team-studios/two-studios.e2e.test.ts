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

it("numbers in a Studio B group chat", async () => {
  const make = async (name: string, section: string, access: unknown) => { const made = await team.as(owner, "POST", "/api/bots", { name, section }); const bot = made.body.bot as Bot; await team.as(owner, "PUT", `/api/bots/${bot.id}/access`, access); return bot; };
  const B = { everyone: "none", people: { [MEMBER.email]: "chat" } };
  const rooms = await make("Rooms", "Studio B", B), hours = await make("Staff Hours", "Studio B", B), sales = await make("Sales", "Studio B", B);
  const made = await team.as(member, "POST", "/api/groups", { memberIds: [rooms.id, hours.id, sales.id], name: "Studio B numbers", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  const group = made.body.group as { id: string; threadId: string };
  record("the member made the group chat", { status: made.status, ownerCanRead: (await team.as(owner, "GET", `/api/threads/${group.threadId}/messages`)).status });
  script([{ name: "memory_update", server: "agents", input: { action: "append", text: "Rooms today: 12 GROUPCHATNUMBER" } }]);
  rmSync(join(team.home, "dump.json"), { force: true });
  const posted = await team.as(member, "POST", `/api/groups/${group.id}/messages`, { text: "Rooms today: 12 GROUPCHATNUMBER", threadId: group.threadId });
  await until(async () => (await idle()) && existsSync(join(team.home, "dump.json")), 60_000); await sleep(1500);
  record("the member's numbers in it", { status: posted.status, lines: (await rows(owner, group.threadId)).slice(-4).map((row) => ({ kind: row.kind, text: row.text?.slice(0, 90), tool: row.tool?.name })) });
  script(null); rmSync(join(team.home, "dump.json"), { force: true });
  const routine = await team.as(owner, "POST", "/api/routines", { name: "Evening totals", prompt: "Add up today's numbers.", groupId: group.id, schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } });
  record("the owner's routine on the group chat", { status: routine.status, body: JSON.stringify(routine.body).slice(0, 240) });
  if (routine.status === 201) {
    const ran = await team.as(owner, "POST", `/api/routines/${routine.body.routine.id}/run`);
    let run: Record<string, unknown> | undefined;
    await until(async () => { run = ((await team.as(owner, "GET", "/api/routines")).body.runs as Array<Record<string, unknown>> | undefined)?.find((candidate) => candidate.id === ran.body.run?.id); return Boolean(run) && ["completed", "failed", "error", "cancelled", "waiting"].includes(String(run!.status)); }, 90_000);
    await sleep(1000);
    const seen = dump();
    record("what that routine's turn is given", { status: run?.status, systemHasIt: seen?.systemPrompt?.includes("GROUPCHATNUMBER") ?? null, promptHasIt: JSON.stringify(seen?.prompt ?? "").includes("GROUPCHATNUMBER"), threadIsTheGroup: run?.threadId === group.threadId });
  }
  const line = await team.as(owner, "GET", "/api/inbox");
  record("owner's inbox after it", (line.body.rows ?? []).slice(0, 4).map((row: Record<string, unknown>) => ({ kind: row.kind, text: String(row.text ?? "").slice(0, 90) })));
}, 300_000);
