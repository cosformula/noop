import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dataActs, localStore, think, type Model } from "../src/brain";
import { loadConfig, P } from "../src/core";
import { due, runRoutines } from "../src/cli";
import { listRoutines, parseDoc, runTool, validRoutineSchedule, type ToolStore } from "../cloud/src/tools";

const config = `[fleet]
primary = "pc"
[idle]
enabled = false
[[routine]]
name = "uptime-watch"
every = "10m"
agent = "lead"
readonly = true
prompt = "Check alerts."
[[routine]]
name = "learn"
kind = "learn"
enabled = false
every = "hourly"
`;

async function fixture(fn: (st: ToolStore) => Promise<void>, io = { pull: async () => true, push: async (_: string) => true }) {
  const paths = ["config.toml", "settings.json", "logs/routine-state.json"];
  const saved = paths.map((p) => existsSync(P(p)) ? readFileSync(P(p), "utf8") : undefined);
  const st = localStore({ acts: dataActs("pc", io), status: () => ({}), feed: () => [] });
  const tasks = new Set(st.list("tasks/").map((f) => f.path));
  mkdirSync(P("logs"), { recursive: true });
  writeFileSync(P("config.toml"), config);
  writeFileSync(P("settings.json"), JSON.stringify({ media_days: 30, routines: { learn: { enabled: false } } }));
  writeFileSync(P("logs/routine-state.json"), "{}");
  try { await fn(st); } finally {
    paths.forEach((p, i) => saved[i] === undefined ? unlinkSync(P(p)) : writeFileSync(P(p), saved[i]!));
    for (const f of st.list("tasks/")) if (!tasks.has(f.path)) unlinkSync(P(f.path));
  }
}

test("routine edits preserve unrelated settings and reach reads and the actual scheduler", () => fixture(async (st) => {
  const prompt = "Read memory/projects.md.\nOnly inspect a working source.";
  const out = await runTool(st, "update_routine", { name: "uptime-watch", enabled: false, every: "120m", prompt });
  expect(out.ok).toBe(true);
  expect(JSON.parse(readFileSync(P("settings.json"), "utf8"))).toEqual({ media_days: 30,
    routines: { learn: { enabled: false }, "uptime-watch": { enabled: false, every: "120m", prompt } } });
  const got = await runTool(st, "get_routine", { name: "uptime-watch" });
  expect(got).toMatchObject({ ok: true, data: { enabled: false, every: "120m", prompt } });
  expect(listRoutines(st)[0].about).toBe("Read memory/projects.md.");
  const cfg = loadConfig();
  expect(cfg.routine[0]).toMatchObject({ enabled: false, every: "120m", prompt, readonly: true });
  runRoutines(cfg, "pc", true);
  const copies = () => st.list("tasks/").filter((f) => parseDoc(f.text).meta.source === "routine:uptime-watch");
  expect(copies()).toHaveLength(0);
  await runTool(st, "update_routine", { name: "uptime-watch", enabled: true });
  runRoutines(loadConfig(), "pc", true);
  expect(copies()).toHaveLength(1);
  expect(copies()[0].text).toContain(prompt);
  expect(copies()[0].text).toContain("Read-only routine:");
  await runTool(st, "update_routine", { name: "uptime-watch", enabled: false });
  expect(copies()).toHaveLength(1); // disabling does not cancel an existing task
}));

test("invalid routine writes never change settings", () => fixture(async (st) => {
  const before = readFileSync(P("settings.json"), "utf8");
  for (const args of [{ name: "missing", enabled: false }, { name: "uptime-watch" }, { name: "uptime-watch", enabled: "false" },
    { name: "uptime-watch", every: "0m" }, { name: "uptime-watch", every: "2h" }, { name: "uptime-watch", every: "daily 25:00" },
    { name: "uptime-watch", every: "weekly XYZ 12:00" }, { name: "uptime-watch", prompt: " " }, { name: "uptime-watch", prompt: "x".repeat(20_001) },
    { name: "uptime-watch", signal: "echo changed" }, { name: "uptime-watch", readonly: false }, { name: "learn", prompt: "ignored by scheduler" }]) {
    expect((await runTool(st, "update_routine", args)).ok).toBe(false);
    expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  }
}));

test("routine schedules accepted by the tool are understood by due", () => {
  const t = new Date("2026-11-02T19:05:00");
  for (const schedule of ["1m", "120m", "hourly", "daily 19:00", "weekdays 19:00", "weekly MON 19:00"]) {
    expect(validRoutineSchedule(schedule)).toBe(true);
    expect(due(schedule, undefined, t)).toBe(true);
  }
  for (const schedule of ["", "-1m", "0m", "1d", "2h", "1.5m", "1m junk", "daily 9:00", "daily 12:60", "weekly FOO 12:00", "999999999999999999m"])
    expect(validRoutineSchedule(schedule)).toBe(false);
});

test("full routine prompts preserve quoted escapes, literal strings and table-like lines", () => {
  const toml = `[[routine]]\nname = 'quoted'\nevery = "hourly"\nprompt = """\nRead \\"alerts\\".\n[not_a_table]\nagent = \\"not an agent\\"\n[[routine]]\nDo not split this prompt.\n"""\nagent = 'lead'\n[other]\nname = 'not-a-routine'\n`;
  const st = { read: (p: string) => p === "config.toml" ? { text: toml } : null } as ToolStore;
  const expected = (Bun.TOML.parse(toml) as { routine: any[] }).routine;
  const actual = listRoutines(st, true);
  expect(actual).toHaveLength(1);
  expect(actual[0]).toMatchObject({ name: expected[0].name, agent: expected[0].agent, prompt: expected[0].prompt });
  expect(listRoutines({ read: (p: string) => p === "config.toml" ? { text: toml.replace(/\n/g, "\r\n") } : null } as ToolStore, true)).toEqual(actual);
});

test("routine writes revalidate after pull and fail without changing settings if refresh fails", async () => {
  await fixture(async (st) => {
    const out = await runTool(st, "update_routine", { name: "uptime-watch", enabled: false });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("unknown routine") });
    expect(JSON.parse(readFileSync(P("settings.json"), "utf8")).routines["uptime-watch"]).toBeUndefined();
  }, { pull: async () => { writeFileSync(P("config.toml"), ""); return true; }, push: async () => true });
  await fixture(async (st) => {
    const before = readFileSync(P("settings.json"), "utf8");
    expect((await runTool(st, "update_routine", { name: "uptime-watch", enabled: false })).ok).toBe(false);
    expect(readFileSync(P("settings.json"), "utf8")).toBe(before);
  }, { pull: async () => false, push: async () => true });
});

function model(turns: string[]): Model {
  return { open: async () => ({ send: async () => turns.shift() ?? '{"reply":""}', close() {} }) };
}

test("chat reports routine changes after saving, and returns sync failures to the model", async () => {
  const update = '{"calls":[{"tool":"update_routine","args":{"name":"uptime-watch","enabled":false}}],"reply":"已关闭"}';
  await fixture(async (st) => {
    const replies: string[] = [];
    await think({ text: "关闭 uptime-watch" }, st, model([update, '{"reply":"uptime-watch 已关闭。"}']), (reply) => {
      expect(loadConfig().routine[0].enabled).toBe(false);
      replies.push(reply);
    });
    expect(replies).toEqual(["uptime-watch 已关闭。"]);
  });
  await fixture(async (st) => {
    const replies: string[] = [];
    const out = await think({ text: "关闭 uptime-watch" }, st, model([update, '{"reply":"同步尚未确认，不能确认已关闭。"}']), (r) => replies.push(r));
    expect(replies).toEqual(["同步尚未确认，不能确认已关闭。"]);
    expect(out.calls).toMatchObject([{ tool: "update_routine", ok: false, error: expect.stringContaining("sync was not confirmed") }]);
  }, { pull: async () => true, push: async () => false });
});

test("the chat model receives a whole long routine prompt before replacing its content", () => fixture(async (st) => {
  const prompt = "Keep existing rules.\n" + "x".repeat(7000) + "\nPreserve this final rule.";
  await runTool(st, "update_routine", { name: "uptime-watch", prompt });
  const seen: string[] = [];
  const turns = ['{"calls":[{"tool":"get_routine","args":{"name":"uptime-watch"}}]}', '{"reply":"已读取完整指令。"}'];
  await think({ text: "查看 uptime-watch 完整指令" }, st, { open: async () => ({
    send: async (input) => { seen.push(input); return turns.shift()!; }, close() {},
  }) }, () => {});
  expect(seen[1]).toContain("Preserve this final rule.");
}));
