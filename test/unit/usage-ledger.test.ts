import { afterEach, describe, expect, it } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { UsageLedgerStore } from "../../src/shared/usage-ledger.js";
import type { NormalizedUsage, UsageLedgerEntry } from "../../src/shared/types.js";
import { createStoreAndRouter, createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

function usage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0
): NormalizedUsage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite
  };
}

let entrySequence = 0;

function makeEntry(overrides: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  entrySequence += 1;
  return {
    id: `usage-${String(entrySequence).padStart(4, "0")}`,
    sessionName: "alpha",
    agent: "claude",
    provider: "anthropic",
    model: "claude-opus",
    usage: usage(100, 20, 5, 3),
    durationMs: 1200,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("UsageLedgerStore", () => {
  const openStores: UsageLedgerStore[] = [];

  async function openLedger(): Promise<UsageLedgerStore> {
    const ledger = await UsageLedgerStore.open(await createTempDir("puppenclaw-ledger-"));
    openStores.push(ledger);
    return ledger;
  }

  afterEach(() => {
    for (const store of openStores.splice(0)) {
      try {
        store.close();
      } catch {
        // already closed
      }
    }
  });

  it("sums per-session totals and counts turns", async () => {
    const ledger = await openLedger();
    ledger.append(
      makeEntry({
        sessionName: "alpha",
        usage: usage(100, 20, 5, 3),
        timestamp: "2026-01-01T00:00:00.000Z"
      })
    );
    ledger.append(
      makeEntry({
        sessionName: "alpha",
        usage: usage(50, 10, 2, 1),
        timestamp: "2026-01-02T00:00:00.000Z"
      })
    );
    ledger.append(
      makeEntry({
        sessionName: "beta",
        agent: "codex",
        provider: "openai",
        model: "gpt-5",
        usage: usage(7, 3),
        timestamp: "2026-01-03T00:00:00.000Z"
      })
    );

    expect(ledger.perSessionTotals("alpha")).toEqual({
      turns: 2,
      usage: usage(150, 30, 7, 4)
    });
    expect(ledger.perSessionTotals("beta")).toEqual({
      turns: 1,
      usage: usage(7, 3)
    });
  });

  it("returns per-session history newest-first and respects the limit", async () => {
    const ledger = await openLedger();
    const first = makeEntry({
      sessionName: "alpha",
      usage: usage(1, 1),
      timestamp: "2026-01-01T00:00:00.000Z"
    });
    const second = makeEntry({
      sessionName: "alpha",
      usage: usage(2, 2),
      timestamp: "2026-01-02T00:00:00.000Z"
    });
    const third = makeEntry({
      sessionName: "alpha",
      usage: usage(3, 3),
      timestamp: "2026-01-03T00:00:00.000Z"
    });
    ledger.append(first);
    ledger.append(second);
    ledger.append(third);
    ledger.append(
      makeEntry({
        sessionName: "other",
        timestamp: "2026-01-04T00:00:00.000Z"
      })
    );

    const history = ledger.perSessionHistory("alpha");
    expect(history.map((entry) => entry.id)).toEqual([third.id, second.id, first.id]);
    expect(history[0]).toEqual(third);

    const limited = ledger.perSessionHistory("alpha", 2);
    expect(limited.map((entry) => entry.id)).toEqual([third.id, second.id]);
  });

  it("rolls up totals by provider and model", async () => {
    const ledger = await openLedger();
    ledger.append(
      makeEntry({
        sessionName: "alpha",
        provider: "anthropic",
        model: "claude-opus",
        usage: usage(100, 20, 5, 3),
        timestamp: "2026-01-01T00:00:00.000Z"
      })
    );
    ledger.append(
      makeEntry({
        sessionName: "beta",
        provider: "anthropic",
        model: "claude-opus",
        usage: usage(40, 10, 1, 1),
        timestamp: "2026-01-02T00:00:00.000Z"
      })
    );
    ledger.append(
      makeEntry({
        sessionName: "beta",
        agent: "codex",
        provider: "openai",
        model: "gpt-5",
        usage: usage(9, 4, 2, 0),
        timestamp: "2026-01-03T00:00:00.000Z"
      })
    );

    const rollup = ledger.perModelRollup();
    expect(rollup).toHaveLength(2);
    expect(rollup[0]).toEqual({
      provider: "anthropic",
      model: "claude-opus",
      turns: 2,
      usage: usage(140, 30, 6, 4)
    });
    expect(rollup[1]).toEqual({
      provider: "openai",
      model: "gpt-5",
      turns: 1,
      usage: usage(9, 4, 2, 0)
    });
  });

  it("computes grand totals across all sessions and models", async () => {
    const ledger = await openLedger();
    ledger.append(
      makeEntry({
        sessionName: "alpha",
        usage: usage(10, 5, 2, 1),
        timestamp: "2026-01-01T00:00:00.000Z"
      })
    );
    ledger.append(
      makeEntry({
        sessionName: "beta",
        provider: "openai",
        model: "gpt-5",
        usage: usage(20, 6, 0, 0),
        timestamp: "2026-01-02T00:00:00.000Z"
      })
    );

    expect(ledger.grandTotals()).toEqual({
      turns: 2,
      usage: usage(30, 11, 2, 1)
    });
  });

  it("applies a since filter to rollups and grand totals", async () => {
    const ledger = await openLedger();
    ledger.append(
      makeEntry({
        sessionName: "alpha",
        provider: "anthropic",
        model: "claude-opus",
        usage: usage(100, 20, 5, 3),
        timestamp: "2026-01-15T00:00:00.000Z"
      })
    );
    ledger.append(
      makeEntry({
        sessionName: "beta",
        provider: "openai",
        model: "gpt-5",
        usage: usage(8, 2, 1, 0),
        timestamp: "2026-02-15T00:00:00.000Z"
      })
    );

    const since = "2026-02-01T00:00:00.000Z";
    expect(ledger.grandTotals(since)).toEqual({
      turns: 1,
      usage: usage(8, 2, 1, 0)
    });
    const rollup = ledger.perModelRollup(since);
    expect(rollup).toEqual([
      {
        provider: "openai",
        model: "gpt-5",
        turns: 1,
        usage: usage(8, 2, 1, 0)
      }
    ]);

    const sinceFuture = "2027-01-01T00:00:00.000Z";
    expect(ledger.grandTotals(sinceFuture)).toEqual({
      turns: 0,
      usage: usage(0, 0)
    });
    expect(ledger.perModelRollup(sinceFuture)).toEqual([]);
  });

  it("returns zero totals and empty results for an empty ledger", async () => {
    const ledger = await openLedger();
    expect(ledger.perSessionTotals("missing")).toEqual({
      turns: 0,
      usage: usage(0, 0)
    });
    expect(ledger.perSessionHistory("missing")).toEqual([]);
    expect(ledger.perModelRollup()).toEqual([]);
    expect(ledger.grandTotals()).toEqual({
      turns: 0,
      usage: usage(0, 0)
    });
  });

  it("records turn usage from a live session and survives purge", async () => {
    const workspaceDir = await createTempDir("puppenclaw-usage-session-");
    const ledgerDir = await createTempDir("puppenclaw-usage-ledger-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const { store, outputRouter } = await createStoreAndRouter(workspaceDir);
    const ledger = await UsageLedgerStore.open(ledgerDir);
    openStores.push(ledger);

    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store,
      outputRouter,
      ledger
    });

    await manager.start({
      agent: "claude",
      name: "usage-demo",
      directory: workspaceDir,
      task: "Summarize the token accounting behavior of this project in enough detail to produce input tokens.",
      contextFiles: []
    });

    const totals = ledger.perSessionTotals("usage-demo");
    expect(totals.turns).toBeGreaterThanOrEqual(1);
    expect(totals.usage.input).toBeGreaterThan(0);
    expect(totals.usage.output).toBe(12);
    expect(totals.usage.cacheRead).toBe(5);
    expect(totals.usage.cacheWrite).toBe(3);
    expect(totals.usage.total).toBe(
      totals.usage.input + totals.usage.output + totals.usage.cacheRead + totals.usage.cacheWrite
    );

    const history = ledger.perSessionHistory("usage-demo");
    expect(history.length).toBe(totals.turns);
    expect(history[0]?.sessionName).toBe("usage-demo");
    expect(history[0]?.agent).toBe("claude");

    await manager.purge({ name: "usage-demo" });

    expect(store.getSession("usage-demo")).toBeNull();
    const survivingTotals = ledger.perSessionTotals("usage-demo");
    expect(survivingTotals.turns).toBeGreaterThanOrEqual(1);
    expect(survivingTotals.usage.input).toBeGreaterThan(0);
  });
});
