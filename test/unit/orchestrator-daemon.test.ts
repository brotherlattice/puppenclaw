import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { DaemonOrchestratorClient } from "../../src/orchestrator/client.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

describe("DaemonOrchestratorClient", () => {
  it("talks to the daemon orchestration HTTP surface", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-daemon-");
    await writeFile(join(workspaceDir, "AGENTS.md"), "Use careful experiments.\n", "utf8");
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
        ...(init?.headers != null
          ? { headers: init.headers as Record<string, string> }
          : {})
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

    const client = new DaemonOrchestratorClient({
      config: {
        ...config,
        daemonUrl: "http://puppenclaw.test"
      },
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      }
    });

    try {
      await client.createProject({
        name: "daemon-project",
        rootDir: workspaceDir
      });
      const sync = await client.syncContext({
        projectId: "daemon-project",
        includeFiles: ["AGENTS.md"]
      });
      expect(sync.content[0]?.text).toContain("Synchronized context");

      const campaign = await client.runCampaign({
        projectId: "daemon-project",
        workerId: "local",
        name: "daemon-baseline",
        template: "literature_review",
        task: "Survey the local project constraints.",
        experimentCommands: [],
        experimentParallelism: 1,
        iterations: 1,
        steps: []
      });
      const details = campaign.details as {
        campaign: {
          state: string;
        };
      };
      expect(details.campaign.state).toBe("completed");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  }, 20_000);
});
