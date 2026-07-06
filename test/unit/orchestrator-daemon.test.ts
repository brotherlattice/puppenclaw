import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { createDaemonServer } from "../../src/daemon/server.js";
import { DaemonOrchestratorClient } from "../../src/orchestrator/client.js";
import { PuppenclawError } from "../../src/shared/errors.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

/** Routes global fetch into the Fastify instance; returns a restore hook. */
function installInjectFetch(app: FastifyInstance): () => void {
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
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function pollUntilState(
  client: DaemonOrchestratorClient,
  campaignId: string,
  states: string[],
  timeoutMs = 20_000
): Promise<{ campaign: { state: string; lastError?: string } }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await client.status({ campaignId });
    const details = result.details as { campaign: { state: string; lastError?: string } };
    if (states.includes(details.campaign.state)) {
      return details;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${states.join("/")}; last: ${details.campaign.state}`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
}

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

  it("supports detached campaigns, scoped events, and daemon error-code propagation", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-daemon-detached-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const config = makeConfig({
      backend: "daemon",
      acpxCommand
    });

    const { app } = await createDaemonServer({
      config,
      dataDir: workspaceDir
    });
    const restoreFetch = installInjectFetch(app);
    const client = new DaemonOrchestratorClient({
      config: {
        ...config,
        daemonUrl: "http://puppenclaw.test"
      },
      logger: silentLogger
    });

    // Command steps run with cwd = project root through a real shell where
    // nested quotes in `node -e "..."` get mangled; run a real script by
    // relative path instead.
    const sleepStep = async (title: string, ms: number, approvalRequired = false) => {
      const scriptName = `sleep-${ms}.cjs`;
      await writeFile(
        join(workspaceDir, scriptName),
        `setTimeout(function(){process.exit(0)},${ms});\n`,
        "utf8"
      );
      return {
        title,
        kind: "experiment" as const,
        executor: "command" as const,
        command: `node ${scriptName}`,
        contextFiles: [],
        approvalRequired,
        env: {},
        retryLimit: 0
      };
    };

    try {
      await client.createProject({
        name: "daemon-detached",
        rootDir: workspaceDir
      });

      // Detached POST /orchestrator/campaign returns quickly with a running
      // snapshot instead of waiting ~3s for the step.
      const startedAt = Date.now();
      const started = await client.runCampaign({
        projectId: "daemon-detached",
        workerId: "local",
        name: "detached-run",
        template: "custom",
        detached: true,
        experimentCommands: [],
        experimentParallelism: 1,
        iterations: 1,
        steps: [await sleepStep("Slow step", 3_000)]
      });
      const elapsedMs = Date.now() - startedAt;
      const startedDetails = started.details as { campaign: { id: string; state: string } };
      expect(startedDetails.campaign.state).toBe("running");
      expect(elapsedMs).toBeLessThan(2_000);

      // While the only worker slot is busy, a second start is rejected and
      // the daemon error code survives the HTTP round-trip as a
      // PuppenclawError (setErrorHandler envelope + client rehydration).
      const rejection = await client
        .runCampaign({
          projectId: "daemon-detached",
          workerId: "local",
          name: "over-capacity",
          template: "custom",
          experimentCommands: [],
          experimentParallelism: 1,
          iterations: 1,
          steps: [await sleepStep("Fast step", 10)]
        })
        .then(
          () => null,
          (error: unknown) => error
        );
      expect(rejection).toBeInstanceOf(PuppenclawError);
      expect((rejection as PuppenclawError).code).toBe("WORKER_CAPACITY_REACHED");

      const campaignId = startedDetails.campaign.id;
      const finished = await pollUntilState(client, campaignId, ["completed", "failed", "cancelled"]);
      expect(finished.campaign.state, finished.campaign.lastError).toBe("completed");

      // GET /orchestrator/events?scope=all returns integer-cursor events.
      const events = await client.campaignEvents({ campaignId, scope: "all", limit: 100 });
      const eventDetails = events.details as {
        scope?: string;
        cursor?: string;
        events: Array<{ id: number; type: string }>;
      };
      expect(eventDetails.scope).toBe("all");
      expect(eventDetails.events.length).toBeGreaterThanOrEqual(3);
      expect(eventDetails.events.every((event) => Number.isInteger(event.id))).toBe(true);
      expect(eventDetails.events.map((event) => event.type)).toContain("campaign_completed");
      expect(eventDetails.cursor).toBe(String(eventDetails.events.at(-1)!.id));

      // POST /orchestrator/approve accepts detached.
      const gated = await client.runCampaign({
        projectId: "daemon-detached",
        workerId: "local",
        name: "gated-run",
        template: "custom",
        experimentCommands: [],
        experimentParallelism: 1,
        iterations: 1,
        steps: [await sleepStep("Gated step", 10, true)]
      });
      const gatedDetails = gated.details as { campaign: { id: string; state: string } };
      expect(gatedDetails.campaign.state).toBe("waiting_approval");
      const approved = await client.approve({
        campaignId: gatedDetails.campaign.id,
        detached: true
      });
      expect((approved.details as { campaign: { state: string } }).campaign.state).toBe("running");
      const gatedFinished = await pollUntilState(client, gatedDetails.campaign.id, [
        "completed",
        "failed",
        "cancelled"
      ]);
      expect(gatedFinished.campaign.state, gatedFinished.campaign.lastError).toBe("completed");
    } finally {
      restoreFetch();
      await app.close();
    }
  }, 40_000);
});
