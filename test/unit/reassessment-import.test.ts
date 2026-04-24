import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { importReassessmentSessions } from "../../src/orchestrator/reassessment.js";
import type { ProjectRecord } from "../../src/orchestrator/types.js";
import { SessionStore } from "../../src/shared/store.js";
import { createTempDir } from "../helpers.js";

describe("reassessment session import", () => {
  it("imports matching Claude Code and Codex JSONL histories without reading credentials", async () => {
    const oldHome = process.env.HOME;
    const homeDir = await createTempDir("puppenclaw-home-");
    const projectRoot = await createTempDir("puppenclaw-import-project-");
    process.env.HOME = homeDir;
    try {
      const claudeProjectDir = join(homeDir, ".claude", "projects", "-tmp-puppenclaw-import-project");
      await mkdir(claudeProjectDir, { recursive: true });
      await writeFile(
        join(claudeProjectDir, "claude-session.jsonl"),
        [
          JSON.stringify({
            type: "user",
            sessionId: "claude-1",
            cwd: projectRoot,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { content: "Fix the demo-project behavior." }
          }),
          JSON.stringify({
            type: "assistant",
            sessionId: "claude-1",
            cwd: projectRoot,
            timestamp: "2026-01-01T00:01:00.000Z",
            message: { content: "I made an incomplete change." }
          })
        ].join("\n") + "\n",
        "utf8"
      );
      const codexDir = join(homeDir, ".codex");
      await mkdir(codexDir, { recursive: true });
      await writeFile(
        join(codexDir, "session_index.jsonl"),
        `${JSON.stringify({
          id: "codex-1",
          thread_name: "demo-project reassessment",
          updated_at: "2026-01-02T00:00:00.000Z"
        })}\n`,
        "utf8"
      );
      await writeFile(
        join(codexDir, "history.jsonl"),
        `${JSON.stringify({
          session_id: "codex-1",
          ts: "2026-01-02T00:00:00.000Z",
          text: `Work in ${projectRoot} on demo-project.`
        })}\n`,
        "utf8"
      );

      const project: ProjectRecord = {
        id: "demo-project",
        name: "demo-project",
        rootDir: projectRoot,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
      const result = await importReassessmentSessions({
        project,
        providers: ["claude", "codex"],
        limit: 10,
        sessionStore: await SessionStore.open(join(homeDir, "state"))
      });

      expect(result.sessions.map((session) => session.provider).sort()).toEqual(["claude", "codex"]);
      expect(result.sessions.every((session) => session.transcriptHash.length > 0)).toBe(true);
      expect(result.warnings.some((warning) => warning.includes("Codex JSONL"))).toBe(true);
    } finally {
      if (oldHome == null) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
    }
  });
});
