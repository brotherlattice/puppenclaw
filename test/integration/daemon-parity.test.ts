import { describe, expect, it } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { DaemonSessionManager } from "../../src/manager/daemon.js";
import { createDaemonServer } from "../../src/daemon/server.js";
import { OutputRouter } from "../../src/plugin/output-router.js";
import { createStoreAndRouter, createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

describe("daemon/local parity", () => {
  it("returns comparable output for the same task", async () => {
    const acpxCommand = await resolveFakeAcpxCommand();
    const localDir = await createTempDir("puppenclaw-parity-local-");
    const daemonDir = await createTempDir("puppenclaw-parity-daemon-");

    const localState = await createStoreAndRouter(localDir);
    const localManager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: localState.store,
      outputRouter: localState.outputRouter
    });

    const config = makeConfig({
      backend: "daemon",
      acpxCommand
    });
    const { app } = await createDaemonServer({
      config,
      dataDir: daemonDir
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

    const daemonManager = new DaemonSessionManager({
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
      const local = await localManager.start({
        agent: "codex",
        name: "parity",
        directory: localDir,
        task: "Implement parity test task.",
        contextFiles: []
      });
      const remote = await daemonManager.start({
        agent: "codex",
        name: "parity",
        directory: daemonDir,
        task: "Implement parity test task.",
        contextFiles: []
      });
      const localDetails = local.details as { output: string };
      const remoteDetails = remote.details as { output: string };

      expect(localDetails.output).toContain("Handled:");
      expect(remoteDetails.output).toContain("Handled:");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});
