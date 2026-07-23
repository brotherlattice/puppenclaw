import { describe, expect, it } from "vitest";

import { ResourceStore, type ResourceSampleRow } from "../../src/resources/store.js";
import { createTempDir } from "../helpers.js";

function sessionRow(overrides: Partial<ResourceSampleRow> = {}): ResourceSampleRow {
  return {
    sessionName: "chat-a",
    kind: "session",
    state: "running",
    cpuPct: 10,
    rssBytes: 1000,
    processCount: 2,
    topProcesses: [{ name: "python", cpuPct: 8, rssBytes: 800 }],
    ...overrides
  };
}

const host = {
  cpuPct: 25,
  cpuCount: 8,
  memTotalBytes: 16_000,
  memAvailableBytes: 8_000,
  load1: 1.5,
  load5: 1.0,
  load15: 0.5
};

describe("resource store", () => {
  it("opens idempotently against an existing database", async () => {
    const root = await createTempDir("puppenclaw-resource-store-");
    const first = await ResourceStore.open(root);
    first.insertTick(1000, [sessionRow()], host);
    first.close();
    const second = await ResourceStore.open(root);
    try {
      const series = second.sessionSeries({ sinceMs: 0, untilMs: 10_000, bucketMs: 1000 });
      expect(series).toHaveLength(1);
      expect(series[0]?.points).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("inserts all rows of one tick with the shared ts and buckets per-session series", async () => {
    const root = await createTempDir("puppenclaw-resource-store-");
    const store = await ResourceStore.open(root);
    try {
      const minute = 60_000;
      // Two ticks in bucket 1, one tick in bucket 2.
      store.insertTick(1 * minute, [
        sessionRow({ cpuPct: 10, rssBytes: 1000, processCount: 2 }),
        sessionRow({ sessionName: "chat-b", cpuPct: 5, rssBytes: 500, processCount: 1 })
      ], host);
      store.insertTick(1 * minute + 30_000, [
        sessionRow({ cpuPct: 30, rssBytes: 3000, processCount: 4, topProcesses: [{ name: "R", cpuPct: 29, rssBytes: 2900 }] }),
        sessionRow({ sessionName: "chat-b", cpuPct: 15, rssBytes: 1500, processCount: 3 })
      ], { ...host, cpuPct: 75 });
      store.insertTick(2 * minute, [sessionRow({ cpuPct: 50, rssBytes: 5000, processCount: 5 })], host);

      const series = store.sessionSeries({ sinceMs: 0, untilMs: 10 * minute, bucketMs: minute });
      const chatA = series.find((entry) => entry.name === "chat-a");
      const chatB = series.find((entry) => entry.name === "chat-b");
      expect(chatA?.kind).toBe("session");
      expect(chatA?.points).toHaveLength(2);
      expect(chatA?.points[0]).toMatchObject({
        tsMs: minute,
        avgCpuPct: 20,
        maxCpuPct: 30,
        avgRssBytes: 2000,
        maxRssBytes: 3000,
        maxProcessCount: 4,
        samples: 2
      });
      // top_processes of the bucket comes from the MAX(cpu_pct) row.
      expect(chatA?.points[0]?.topProcesses).toEqual([{ name: "R", cpuPct: 29, rssBytes: 2900 }]);
      expect(chatA?.points[1]).toMatchObject({ tsMs: 2 * minute, avgCpuPct: 50, samples: 1 });
      expect(chatB?.points).toHaveLength(1);
      expect(chatB?.points[0]).toMatchObject({ avgCpuPct: 10, maxCpuPct: 15, samples: 2 });

      // Totals sum concurrent rows per shared tick ts before bucketing:
      // tick1 = 15, tick2 = 45 -> bucket avg 30, max 45; tick3 alone = 50.
      const totals = store.totalsSeries({ sinceMs: 0, untilMs: 10 * minute, bucketMs: minute });
      expect(totals).toHaveLength(2);
      expect(totals[0]).toMatchObject({
        tsMs: minute,
        avgCpuPct: 30,
        maxCpuPct: 45,
        avgRssBytes: 3000,
        maxRssBytes: 4500,
        maxProcessCount: 7,
        samples: 2
      });
      expect(totals[1]).toMatchObject({ tsMs: 2 * minute, avgCpuPct: 50, samples: 1 });

      const hostSeries = store.hostSeries({ sinceMs: 0, untilMs: 10 * minute, bucketMs: minute });
      expect(hostSeries).toHaveLength(2);
      expect(hostSeries[0]).toMatchObject({
        tsMs: minute,
        avgCpuPct: 50,
        maxCpuPct: 75,
        avgMemUsedBytes: 8000,
        memTotalBytes: 16_000,
        avgLoad1: 1.5,
        samples: 2
      });
    } finally {
      store.close();
    }
  });

  it("keeps the unlinked rollup as its own kind series with an empty name", async () => {
    const root = await createTempDir("puppenclaw-resource-store-");
    const store = await ResourceStore.open(root);
    try {
      store.insertTick(60_000, [
        sessionRow(),
        sessionRow({ sessionName: "", kind: "unlinked", state: "active", cpuPct: 3, rssBytes: 300, processCount: 1, topProcesses: [] })
      ], null);
      const series = store.sessionSeries({ sinceMs: 0, untilMs: 120_000, bucketMs: 60_000 });
      const unlinked = series.find((entry) => entry.kind === "unlinked");
      expect(unlinked?.name).toBe("");
      expect(unlinked?.points[0]).toMatchObject({ avgCpuPct: 3, samples: 1 });
      // Session filter narrows to that session only.
      const filtered = store.sessionSeries({
        sinceMs: 0,
        untilMs: 120_000,
        bucketMs: 60_000,
        sessionName: "chat-a"
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.name).toBe("chat-a");
    } finally {
      store.close();
    }
  });

  it("leaves gaps for buckets without samples", async () => {
    const root = await createTempDir("puppenclaw-resource-store-");
    const store = await ResourceStore.open(root);
    try {
      store.insertTick(60_000, [sessionRow()], host);
      store.insertTick(300_000, [sessionRow()], host);
      const series = store.sessionSeries({ sinceMs: 0, untilMs: 600_000, bucketMs: 60_000 });
      expect(series[0]?.points.map((point) => point.tsMs)).toEqual([60_000, 300_000]);
    } finally {
      store.close();
    }
  });

  it("prunes rows older than the cutoff and reports the deleted count", async () => {
    const root = await createTempDir("puppenclaw-resource-store-");
    const store = await ResourceStore.open(root);
    try {
      store.insertTick(1_000, [sessionRow(), sessionRow({ sessionName: "chat-b" })], host);
      store.insertTick(500_000, [sessionRow()], host);
      // 2 resource rows + 1 host row below the cutoff.
      expect(store.prune(400_000)).toBe(3);
      expect(store.prune(400_000)).toBe(0);
      const series = store.sessionSeries({ sinceMs: 0, untilMs: 1_000_000, bucketMs: 60_000 });
      expect(series).toHaveLength(1);
      expect(series[0]?.points).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("respects the exclusive until bound", async () => {
    const root = await createTempDir("puppenclaw-resource-store-");
    const store = await ResourceStore.open(root);
    try {
      store.insertTick(60_000, [sessionRow()], host);
      store.insertTick(120_000, [sessionRow()], host);
      const series = store.sessionSeries({ sinceMs: 0, untilMs: 120_000, bucketMs: 60_000 });
      expect(series[0]?.points).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
