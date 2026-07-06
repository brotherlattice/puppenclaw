import { describe, expect, it } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { DaemonSessionManager } from "../../src/manager/daemon.js";
import { createDaemonServer } from "../../src/daemon/server.js";
import { OutputRouter } from "../../src/plugin/output-router.js";
import { UsageLedgerStore } from "../../src/shared/usage-ledger.js";
import { createStoreAndRouter, createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

type UsageBuckets = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

type RollupDetails = {
  rollup: Array<{ provider: string; model: string; turns: number; usage: UsageBuckets }>;
  totals: { turns: number; usage: UsageBuckets };
  since: string | null;
  pricing: null;
};

describe("daemon/local parity", () => {
  it("returns comparable output for the same task", async () => {
    const acpxCommand = await resolveFakeAcpxCommand();
    const localDir = await createTempDir("puppenclaw-parity-local-");
    const daemonDir = await createTempDir("puppenclaw-parity-daemon-");

    const localState = await createStoreAndRouter(localDir);
    const localLedger = await UsageLedgerStore.open(await createTempDir("puppenclaw-parity-ledger-"));
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
      outputRouter: localState.outputRouter,
      ledger: localLedger
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

      // Per-session usage parity: local cost() vs daemon GET /session/:name/cost.
      const localCost = await localManager.cost({ name: "parity" });
      const remoteCost = await daemonManager.cost({ name: "parity" });
      const localCostDetails = localCost.details as {
        name: string;
        totals: { turns: number; usage: UsageBuckets } | null;
        pricing: null;
      };
      const remoteCostDetails = remoteCost.details as typeof localCostDetails;
      expect(localCostDetails.name).toBe("parity");
      expect(remoteCostDetails.name).toBe("parity");
      expect(localCostDetails.totals?.turns).toBeGreaterThanOrEqual(1);
      expect(remoteCostDetails.totals?.turns).toBeGreaterThanOrEqual(1);
      expect(localCostDetails.pricing).toBeNull();
      expect(remoteCostDetails.pricing).toBeNull();

      // Rollup usage parity: local cost({}) vs daemon GET /usage.
      const localRollup = await localManager.cost({});
      const remoteRollup = await daemonManager.cost({});
      const localRollupDetails = localRollup.details as RollupDetails;
      const remoteRollupDetails = remoteRollup.details as RollupDetails;
      for (const details of [localRollupDetails, remoteRollupDetails]) {
        expect(Array.isArray(details.rollup)).toBe(true);
        expect(details.rollup.length).toBeGreaterThanOrEqual(1);
        expect(details.rollup[0]?.provider).toBe("openai");
        expect(details.rollup[0]?.model).toBe("codex-default");
        expect(details.rollup[0]?.usage.output).toBeGreaterThan(0);
        expect(details.totals.turns).toBeGreaterThanOrEqual(1);
        expect(details.totals.usage.total).toBeGreaterThan(0);
        expect(details.since).toBeNull();
        expect(details.pricing).toBeNull();
      }
      expect(remoteRollup.content[0]?.text).toContain("Usage rollup");
      expect(remoteRollup.content[0]?.text).toContain("TOTAL:");

      // The since filter is forwarded through the daemon /usage query string.
      const remoteFiltered = await daemonManager.cost({ since: "2999-01-01T00:00:00.000Z" });
      const remoteFilteredDetails = remoteFiltered.details as RollupDetails;
      expect(remoteFilteredDetails.rollup).toEqual([]);
      expect(remoteFilteredDetails.totals.turns).toBe(0);
      expect(remoteFilteredDetails.since).toBe("2999-01-01T00:00:00.000Z");
    } finally {
      globalThis.fetch = originalFetch;
      localLedger.close();
      await app.close();
    }
  }, 20_000);
});
