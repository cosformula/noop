import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DATA, P, list, precedents, readDoc, writeDoc } from "../src/core";
import { supersedeMenus } from "../src/decisions";

// The temp hub is shared with other test files: only create, assert on and remove the files this file writes.
// Ids sort after any other fixture (D-Z…, T-Z…) so precedents()'s newest-first window sees them first.
const written = new Set<string>();
const put = (rel: string, meta: Record<string, string | undefined>, body: string) => {
  const parts = rel.split("/");
  const p = P(...parts);
  mkdirSync(P(...parts.slice(0, -1)), { recursive: true });
  writeDoc(p, meta, body);
  written.add(rel);
};
const ids = (dir: string, mine: string[]) => list(P(dir)).map((p) => readDoc(p).meta.id).filter((id) => mine.includes(id)).sort();

beforeEach(() => {
  if (!DATA.startsWith(tmpdir())) throw new Error(`Refusing to use live DATA: ${DATA}`);
});
afterEach(() => {
  // supersedeMenus moves our files between open/closed and blocked/done: remove every place they may have landed
  for (const rel of written) {
    const name = rel.split("/").pop()!;
    for (const dir of ["decisions/open", "decisions/closed", "tasks/blocked", "tasks/done", "tasks/inbox"])
      rmSync(P(...dir.split("/"), name), { force: true });
  }
  written.clear();
});

const card = (id: string, task: string, kind?: string) => {
  put(`decisions/open/${id}.md`, { id, task, agent: "chief-of-staff", kind, question: "这次执行哪几项？", created: new Date().toISOString() }, "## Context\nmenu\n");
  put(`tasks/blocked/${task}.md`, { id: task, agent: "chief-of-staff", status: "blocked", decision: id }, "body");
};

test("a new menu closes every older unanswered menu without resuming its task", () => {
  card("D-ZF001", "T-Z001", "menu");
  card("D-ZF002", "T-Z002", "menu");
  card("D-ZF003", "T-Z003", "menu");
  card("D-Z0009", "T-Z009"); // an ordinary decision stays open
  const mine = ["D-ZF001", "D-ZF002", "D-ZF003", "D-Z0009"];
  expect(supersedeMenus("D-ZF003").filter((id) => mine.includes(id)).sort()).toEqual(["D-ZF001", "D-ZF002"]);

  expect(ids("decisions/open", mine)).toEqual(["D-Z0009", "D-ZF003"]);
  const closed = readDoc(P("decisions", "closed", "D-ZF001.md")).meta;
  expect(closed.answer).toBe("superseded:D-ZF003");
  expect(closed.answered_by).toBe("system");
  // the old menu task is finished, not woken up to act on a non-answer
  expect(existsSync(P("tasks", "blocked", "T-Z001.md"))).toBe(false);
  expect(ids("tasks/inbox", ["T-Z001", "T-Z002"])).toEqual([]);
  expect(readDoc(P("tasks", "done", "T-Z001.md")).meta.superseded_by).toBe("D-ZF003");
  expect(existsSync(P("tasks", "blocked", "T-Z003.md"))).toBe(true);
  expect(existsSync(P("tasks", "blocked", "T-Z009.md"))).toBe(true);
});

test("superseded cards are not precedents, and the window still holds n real rulings", () => {
  put("decisions/closed/D-Z0001.md", { id: "D-Z0001", agent: "reviewer", question: "合并吗？", answer: "A", answered_by: "owner(chat)" }, "");
  put("decisions/closed/D-Z0002.md", { id: "D-Z0002", agent: "reviewer", question: "范围？", answer: "B", answered_by: "owner(chat)" }, "");
  for (let i = 1; i <= 5; i++)
    put(`decisions/closed/D-ZF00${i}.md`, { id: `D-ZF00${i}`, agent: "chief-of-staff", question: "这次执行哪几项？", answer: "superseded:D-ZF009", answered_by: "system" }, "");
  put("decisions/closed/P-Z0001.md", { id: "P-Z0001", question: "要做哪几项？", answer: "superseded (rebuilt)", answered_by: "system" }, "");
  const out = precedents(2);
  expect(out).toContain("D-Z0001");
  expect(out).toContain("D-Z0002");
  expect(out).not.toContain("superseded");
  expect(out.indexOf("D-Z0001")).toBeLessThan(out.indexOf("D-Z0002"));
});
