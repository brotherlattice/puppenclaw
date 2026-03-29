import { describe, expect, it } from "vitest";

import { DaemonSessionManager } from "../../src/manager/daemon.js";
import { createDaemonServer } from "../../src/daemon/server.js";
import { OutputRouter } from "../../src/plugin/output-router.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

describe("DaemonSessionManager", () => {
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

      const cost = await manager.cost({ name: "daemon-demo" });
      const costDetails = cost.details as { name: string };
      expect(costDetails.name).toBe("daemon-demo");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});
