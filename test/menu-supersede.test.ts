import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DATA, P, list, precedents, readDoc, writeDoc } from "../src/core";
import { supersedeMenus } from "../src/decisions";

const dirs = ["tasks/blocked", "tasks/done", "tasks/inbox", "decisions/open", "decisions/closed"];

beforeEach(() => {
  if (!DATA.startsWith(tmpdir())) throw new Error(`Refusing to use live DATA: ${DATA}`);
  for (const dir of dirs) {
    rmSync(P(dir), { recursive: true, force: true });
    mkdirSync(P(dir), { recursive: true });
  }
});
afterAll(() => {
  for (const dir of dirs) rmSync(P(dir), { recursive: true, force: true });
});

const card = (id: string, task: string, kind?: string) => {
  writeDoc(P("decisions/open", `${id}.md`), { id, task, agent: "chief-of-staff", kind, question: "这次执行哪几项？", created: new Date().toISOString() }, "## Context\nmenu\n");
  writeDoc(P("tasks/blocked", `${task}.md`), { id: task, agent: "chief-of-staff", status: "blocked", decision: id }, "body");
};

test("a new menu closes every older unanswered menu without resuming its task", () => {
  card("D-F0001", "T-0001", "menu");
  card("D-F0002", "T-0002", "menu");
  card("D-F0003", "T-0003", "menu");
  card("D-0009", "T-0009"); // an ordinary decision stays open
  expect(supersedeMenus("D-F0003").sort()).toEqual(["D-F0001", "D-F0002"]);

  expect(list(P("decisions/open")).map((p) => readDoc(p).meta.id).sort()).toEqual(["D-0009", "D-F0003"]);
  const closed = readDoc(P("decisions/closed", "D-F0001.md")).meta;
  expect(closed.answer).toBe("superseded:D-F0003");
  expect(closed.answered_by).toBe("system");
  // the old menu task is finished, not woken up to act on a non-answer
  expect(existsSync(P("tasks/blocked", "T-0001.md"))).toBe(false);
  expect(list(P("tasks/inbox"))).toEqual([]);
  expect(readDoc(P("tasks/done", "T-0001.md")).meta.superseded_by).toBe("D-F0003");
  expect(existsSync(P("tasks/blocked", "T-0003.md"))).toBe(true);
  expect(existsSync(P("tasks/blocked", "T-0009.md"))).toBe(true);
});

test("superseded cards are not precedents, and the window still holds n real rulings", () => {
  writeDoc(P("decisions/closed", "D-0001.md"), { id: "D-0001", agent: "reviewer", question: "合并吗？", answer: "A", answered_by: "owner(chat)" }, "");
  writeDoc(P("decisions/closed", "D-0002.md"), { id: "D-0002", agent: "reviewer", question: "范围？", answer: "B", answered_by: "owner(chat)" }, "");
  for (let i = 1; i <= 5; i++)
    writeDoc(P("decisions/closed", `D-F000${i}.md`), { id: `D-F000${i}`, agent: "chief-of-staff", question: "这次执行哪几项？", answer: "superseded:D-F0009", answered_by: "system" }, "");
  writeDoc(P("decisions/closed", "P-0001.md"), { id: "P-0001", question: "要做哪几项？", answer: "superseded (rebuilt)", answered_by: "system" }, "");
  const out = precedents(2);
  expect(out).toContain("D-0001");
  expect(out).toContain("D-0002");
  expect(out).not.toContain("superseded");
  expect(out.indexOf("D-0001")).toBeLessThan(out.indexOf("D-0002"));
});
