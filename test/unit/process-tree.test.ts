import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildProcessTreeKillPlan, killProcessTree } from "../../src/shared/process-tree.js";
import { createTempDir } from "../helpers.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(100);
  }
  return predicate();
}

describe("buildProcessTreeKillPlan", () => {
  it("builds a taskkill /T /F plan on win32 for any signal", () => {
    expect(buildProcessTreeKillPlan(1234, "SIGTERM", "win32")).toEqual({
      method: "taskkill",
      command: "taskkill",
      args: ["/pid", "1234", "/T", "/F"]
    });
    expect(buildProcessTreeKillPlan(9876, "SIGKILL", "win32")).toEqual({
      method: "taskkill",
      command: "taskkill",
      args: ["/pid", "9876", "/T", "/F"]
    });
  });

  it("targets the negative-pid process group on POSIX", () => {
    expect(buildProcessTreeKillPlan(1234, "SIGTERM", "linux")).toEqual({
      method: "process-group",
      target: -1234,
      signal: "SIGTERM"
    });
    expect(buildProcessTreeKillPlan(1234, "SIGKILL", "darwin")).toEqual({
      method: "process-group",
      target: -1234,
      signal: "SIGKILL"
    });
  });

  it("falls back to a direct kill when the pid is unknown", () => {
    expect(buildProcessTreeKillPlan(undefined, "SIGTERM", "linux")).toEqual({
      method: "direct",
      signal: "SIGTERM"
    });
    expect(buildProcessTreeKillPlan(undefined, "SIGKILL", "win32")).toEqual({
      method: "direct",
      signal: "SIGKILL"
    });
  });
});

describe("killProcessTree", () => {
  it("kills grandchildren that would outlive a wrapper-only kill", async () => {
    const workspaceDir = await createTempDir("puppenclaw-tree-kill-");
    const parentPath = join(workspaceDir, "tree-parent.mjs");
    const pidFile = join(workspaceDir, "grandchild.pid");
    await writeFile(
      parentPath,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {',
        '  stdio: "ignore"',
        "});",
        'writeFileSync(process.argv[2], String(grandchild.pid), "utf8");',
        "setInterval(() => {}, 1000);",
        ""
      ].join("\n"),
      "utf8"
    );

    const child = spawn(process.execPath, [parentPath, pidFile], {
      stdio: "ignore",
      detached: process.platform !== "win32"
    });
    let grandchildPid: number | null = null;
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && grandchildPid == null) {
        const raw = await readFile(pidFile, "utf8").catch(() => "");
        const parsed = Number.parseInt(raw.trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          grandchildPid = parsed;
          break;
        }
        await sleep(100);
      }
      expect(grandchildPid).not.toBeNull();
      expect(isProcessAlive(grandchildPid as number)).toBe(true);

      killProcessTree(child, "SIGKILL");

      const grandchildGone = await waitFor(
        () => !isProcessAlive(grandchildPid as number),
        10_000
      );
      expect(grandchildGone).toBe(true);
      const parentGone = await waitFor(
        () => child.pid == null || !isProcessAlive(child.pid),
        10_000
      );
      expect(parentGone).toBe(true);
    } finally {
      // Best-effort cleanup if an assertion failed before the tree died.
      killProcessTree(child, "SIGKILL");
      if (grandchildPid != null) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 30_000);
});
