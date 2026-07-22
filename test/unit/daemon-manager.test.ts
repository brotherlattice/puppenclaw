import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DaemonSessionManager } from "../../src/manager/daemon.js";
import { createDaemonServer } from "../../src/daemon/server.js";
import { OutputRouter } from "../../src/plugin/output-router.js";
import { REASONING_CAPABILITIES } from "../../src/shared/reasoning.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

async function resolveFakeDaemonCodexCommand(workspaceDir: string): Promise<string> {
  const commandPath = join(workspaceDir, "fake-daemon-codex.mjs");
  await writeFile(
    commandPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null;
readFileSync(0, "utf8");

function emit(value) {
  writeSync(1, JSON.stringify(value) + "\\n");
}

writeSync(1, "MALFORMED DAEMON token=daemon-stream-secret\\n");
emit({
  type: "response_item",
  item: {
    type: "function_call",
    name: "exec_command",
    arguments: "{\\"cmd\\":\\"read private input\\",\\"authorization\\":\\"Bearer daemon-tool-secret\\"}"
  }
});
emit({
  type: "response_item",
  item: {
    type: "function_call_output",
    output: "raw daemon tool output token=daemon-output-secret"
  }
});
emit({
  type: "response_item",
  item: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Daemon streamed answer." }]
  }
});
if (outputPath != null) {
  writeFileSync(outputPath, "Daemon canonical answer.", "utf8");
}
`,
    "utf8"
  );
  return `node "${commandPath.replaceAll('"', '\\"')}"`;
}

describe("DaemonSessionManager", () => {
  it("reports the daemon HTTP capabilities", async () => {
    const workspaceDir = await createTempDir("puppenclaw-capabilities-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const config = makeConfig({
      backend: "daemon",
      acpxCommand,
      maxSessions: 7
    });

    const { app } = await createDaemonServer({
      config,
      dataDir: workspaceDir
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/capabilities"
      });
      const payload = JSON.parse(response.body) as {
        sessionStartStream?: boolean;
        sessionSendStream?: boolean;
        sessionModelProviderRefresh?: boolean;
        codexTurnPolicy?: unknown;
        sessionOutput?: boolean;
        sessionPurge?: boolean;
        sessionQuiesce?: boolean;
        sessionQuiesceRelease?: boolean;
        sessionPurgeTransientFencing?: boolean;
        sessionQuiescence?: unknown;
        sessionSkills?: boolean;
        reasoning?: unknown;
        maxSessions?: { min?: number; max?: number; current?: number };
      };

      expect(response.statusCode).toBe(200);
      expect(payload.sessionStartStream).toBe(true);
      expect(payload.sessionSendStream).toBe(true);
      expect(payload.sessionModelProviderRefresh).toBe(true);
      expect(payload.codexTurnPolicy).toEqual({
        version: 1,
        serverControlled: true,
        userExecutionMarkersTrusted: false
      });
      expect(payload.sessionOutput).toBe(true);
      expect(payload.sessionPurge).toBe(true);
      expect(payload.sessionQuiesce).toBe(true);
      expect(payload.sessionQuiesceRelease).toBe(true);
      expect(payload.sessionPurgeTransientFencing).toBe(true);
      expect(payload.sessionQuiescence).toEqual({
        version: 2,
        durable: true,
        releaseRequired: true,
        mutationFencing: true,
        dispatchEpoch: true,
        unknownSessionFencing: true,
        historyPersistent: true
      });
      expect(payload.sessionSkills).toBe(true);
      expect(payload.reasoning).toEqual(REASONING_CAPABILITIES);
      expect(payload.maxSessions).toEqual({
        min: 1,
        max: 100,
        current: 7
      });
    } finally {
      await app.close();
    }
  });

  it("streams tool protocol only as structured daemon activity", async () => {
    const workspaceDir = await createTempDir("puppenclaw-daemon-codex-stream-");
    const codexCommand = await resolveFakeDaemonCodexCommand(workspaceDir);
    const config = makeConfig({
      backend: "daemon",
      agentCommands: { codex: codexCommand }
    });
    const { app } = await createDaemonServer({ config, dataDir: workspaceDir });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/session/start/stream",
        payload: {
          agent: "codex",
          name: "daemon-codex-stream",
          directory: workspaceDir,
          task: "Run a bounded tool turn.",
          modelProviderId: "local-compatible",
          modelProvider: {
            id: "local-compatible",
            kind: "codex-openai-compatible",
            model: "local-model"
          }
        }
      });
      const events = response.body
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
      const visibleEvents = events.filter((event) =>
        ["chunk", "final", "result", "error"].includes(String(event.kind))
      );
      const visibleSurfaces = JSON.stringify(visibleEvents);

      expect(response.statusCode).toBe(200);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "activity",
          activity: expect.objectContaining({
            type: "tool_call",
            title: "exec_command",
            text: expect.stringContaining("Bearer [redacted]") as string
          })
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "activity",
          activity: expect.objectContaining({
            type: "tool_output",
            text: expect.stringContaining("raw daemon tool output") as string
          })
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "final", text: "Daemon canonical answer." })
      );
      for (const hiddenProtocolText of [
        "[tool]",
        "[tool output]",
        "MALFORMED DAEMON",
        "daemon-stream-secret",
        "daemon-tool-secret",
        "read private input",
        "raw daemon tool output",
        "daemon-output-secret"
      ]) {
        expect(visibleSurfaces).not.toContain(hiddenProtocolText);
      }
      expect(JSON.stringify(events)).not.toContain("daemon-tool-secret");
      expect(JSON.stringify(events)).not.toContain("daemon-output-secret");
    } finally {
      await app.close();
    }
  });

  it("talks to the daemon HTTP surface", async () => {
    const workspaceDir = await createTempDir("puppenclaw-daemon-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const config = makeConfig({
      backend: "daemon",
      acpxCommand
    });

    const { app } = await createDaemonServer({
      config,
      dataDir: workspaceDir
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const requestUrl = new URL(
        typeof input === "string" || input instanceof URL ? String(input) : input.url
      );
      const method = (init?.method ?? "GET") as "GET" | "POST" | "DELETE";
      const payload =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      const response = (await app.inject({
        method,
        url: `${requestUrl.pathname}${requestUrl.search}`,
        ...(payload != null ? { payload } : {}),
        ...(init?.headers != null ? { headers: init.headers as Record<string, string> } : {})
      } as never)) as {
        body: string;
        statusCode: number;
        headers: Record<string, string>;
      };
      return new Response(response.body, {
        status: response.statusCode,
        headers: response.headers
      });
    };

    const manager = new DaemonSessionManager({
      config: {
        ...config,
        daemonUrl: "http://puppenclaw.test"
      },
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      outputRouter: new OutputRouter({
        info() {},
        warn() {},
        error() {},
        debug() {}
      })
    });

    try {
      const result = await manager.start({
        agent: "codex",
        name: "daemon-demo",
        directory: workspaceDir,
        task: "Run through the daemon path.",
        contextFiles: []
      });
      const startDetails = result.details as { session: SessionInfo };
      expect(startDetails.session.name).toBe("daemon-demo");

      const approved = await manager.send({
        name: "daemon-demo",
        message: "REPORT_PERMISSION_MODE",
        permissionMode: "approve-all",
        contextFiles: []
      });
      const approvedDetails = approved.details as { session: SessionInfo; output: string };
      expect(approvedDetails.output).toBe("Permission mode: approve-all");
      expect(approvedDetails.session.permissionMode).toBe("approve-reads");

      const following = await manager.send({
        name: "daemon-demo",
        message: "REPORT_PERMISSION_MODE",
        contextFiles: []
      });
      const followingDetails = following.details as { session: SessionInfo; output: string };
      expect(followingDetails.output).toBe("Permission mode: approve-reads");
      expect(followingDetails.session.permissionMode).toBe("approve-reads");

      const cost = await manager.cost({ name: "daemon-demo" });
      const costDetails = cost.details as { name: string };
      expect(costDetails.name).toBe("daemon-demo");

      const output = await manager.output({ name: "daemon-demo" });
      const outputDetails = output.details as {
        output: { text: string; source: string; complete: boolean };
      };
      expect(outputDetails.output.text).toBe("Permission mode: approve-reads");
      expect(outputDetails.output.source).toBe("active-turn");
      expect(outputDetails.output.complete).toBe(true);

      const quiesced = await manager.quiesce({ name: "daemon-demo" });
      const quiescedDetails = quiesced.details as {
        quiescenceEpoch: number;
        runtimeClosed: boolean;
      };
      expect(quiescedDetails).toMatchObject({
        quiescenceEpoch: 1,
        runtimeClosed: true
      });
      await expect(
        manager.send({
          name: "daemon-demo",
          message: "This turn is fenced.",
          contextFiles: []
        })
      ).rejects.toMatchObject({ code: "SESSION_QUIESCED" });

      const resumed = await manager.send({
        name: "daemon-demo",
        message: "Resume through the current lifecycle.",
        lifecycleEpoch: 1,
        contextFiles: []
      });
      expect((resumed.details as { session: SessionInfo }).session.state).not.toBe("running");
      await expect(
        manager.send({
          name: "daemon-demo",
          message: "A stale dispatch must stay rejected.",
          lifecycleEpoch: 2,
          contextFiles: []
        })
      ).rejects.toMatchObject({ code: "STALE_LIFECYCLE_EPOCH" });

      const purge = await manager.purge({ name: "daemon-demo" });
      expect((purge.details as { purged: boolean }).purged).toBe(true);
      await expect(
        manager.releaseQuiescence({
          name: "daemon-demo",
          epoch: (purge.details as { quiescenceEpoch: number }).quiescenceEpoch
        })
      ).rejects.toMatchObject({ code: "STALE_QUIESCENCE_EPOCH" });
      await expect(manager.purge({ name: "daemon-demo" })).rejects.toMatchObject({
        code: "NO_SESSION"
      });
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});
