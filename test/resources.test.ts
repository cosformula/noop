import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleDerivedData } from "../src/resources";

const plist = (date: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>LastAccessedDate</key><date>${date}</date>
<key>WorkspacePath</key><string>/x/App.xcworkspace</string></dict></plist>`;

test.skipIf(process.platform !== "darwin")("staleDerivedData picks idle and orphaned project folders only", async () => {
  const root = mkdtempSync(join(tmpdir(), "dd-"));
  const now = Date.parse("2026-11-06T00:00:00Z");
  const mk = (name: string, date?: string) => {
    mkdirSync(join(root, name));
    if (date) writeFileSync(join(root, name, "info.plist"), plist(date));
  };
  mk("App-active", "2026-11-05T00:00:00Z");
  mk("App-idle", "2026-10-20T00:00:00Z");
  mk("App-orphan");
  utimesSync(join(root, "App-orphan"), new Date(now - 3 * 86400e3), new Date(now - 3 * 86400e3));
  for (const shared of ["ModuleCache.noindex", "SDKExplicitPrecompiledModules", "Files-abc"]) mk(shared);
  try {
    const got = (await staleDerivedData(root, 7, now)).map((p) => p.slice(root.length + 1)).sort();
    expect(got).toEqual(["App-idle", "App-orphan"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workRepos also sweeps the agent scratch dirs, not only work_dirs", async () => {
  const { workRepos } = await import("../src/resources");
  const home = mkdtempSync(join(tmpdir(), "noop-home-"));
  try {
    for (const d of ["work/a/target", ".agent-hub/work/metro/target", ".noop/work/web/node_modules", ".agent-hub/work/plain/src"])
      mkdirSync(join(home, d), { recursive: true });
    const got = workRepos({ resources: { work_dirs: ["~/work"] } } as any, home).map((p) => p.slice(home.length + 1)).sort();
    expect(got).toEqual([".agent-hub/work/metro", ".noop/work/web", "work/a"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cleanableRepos leaves scratch checkouts alone while this host has an active task", async () => {
  const { cleanableRepos } = await import("../src/resources");
  const home = mkdtempSync(join(tmpdir(), "noop-home-"));
  try {
    // the active task records only its main repo; it builds in a scratch checkout of the same project
    for (const d of ["work/noop/target", "work/other/target", ".noop/work/pr-noop-116/target", ".agent-hub/work/metro/target"])
      mkdirSync(join(home, d), { recursive: true });
    const cfg = { resources: { work_dirs: ["~/work"] } } as any;
    const busy = new Set([join(home, "work/noop")]);
    const rel = (ps: string[]) => ps.map((p) => p.slice(home.length + 1)).sort();
    expect(rel(cleanableRepos(cfg, busy, true, home))).toEqual(["work/other"]);
    // idle host: scratch checkouts are fair game again
    expect(rel(cleanableRepos(cfg, new Set(), false, home)))
      .toEqual([".agent-hub/work/metro", ".noop/work/pr-noop-116", "work/noop", "work/other"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
