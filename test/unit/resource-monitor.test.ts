import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComputeJobRecord } from "../../src/compute/types.js";
import { ResourceMonitor } from "../../src/resources/monitor.js";
import { SessionStore } from "../../src/shared/store.js";
import type { SessionInfo } from "../../src/shared/types.js";
import { writeFakeProc, type FakeProcProcess } from "../fixtures/fake-proc.js";
import { createTempDir, makeConfig } from "../helpers.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

function makeSession(overrides: Partial<SessionInfo> & { name: string }): SessionInfo {
  const now = new Date().toISOString();
  return {
    agent: "claude",
    directory: "/tmp",
    state: "running",
    createdAt: now,
    lastActivity: now,
    permissionMode: "approve-reads",
    warnings: [],
    transcript: [],
    ...overrides
  };
}

function makeJob(
  overrides: Partial<ComputeJobRecord> & { id: string }
): ComputeJobRecord {
  return {
    state: "running",
    sessionName: null,
    executor: "bubblewrap-local",
    command: ["true"],
    cwd: "/tmp",
    resources: { cpuCores: 1, memoryMiB: 128, wallTimeSeconds: 60, gpuCount: 0, diskMiB: 0 },
    supervisorPid: null,
    supervisorStartTicks: null,
    childPid: null,
    childStartTicks: null,
    stdoutPath: null,
    stderrPath: null,
    exitCode: null,
    failureCode: null,
    failureMessage: null,
    submittedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    lastHeartbeatAt: null,
    peakMemoryKiB: null,
    cpuSeconds: null,
    readBytes: null,
    writeBytes: null,
    ...overrides
  };
}

async function makeMonitor(params: {
  sessions?: SessionInfo[];
  jobs?: ComputeJobRecord[];
}): Promise<{ monitor: ResourceMonitor; procRoot: string; jobs: ComputeJobRecord[] }> {
  const dataDir = await createTempDir("puppenclaw-resource-monitor-");
  const procRoot = join(dataDir, "proc");
  await writeFakeProc(procRoot, []);
  const sessionStore = await SessionStore.open(dataDir);
  for (const session of params.sessions ?? []) {
    await sessionStore.upsertSession(session);
  }
  const jobs = params.jobs ?? [];
  const monitor = await ResourceMonitor.open({
    dataDir,
    config: makeConfig(),
    logger: silentLogger,
    sessionStore,
    computeJobs: {
      listActive: (sessionName?: string) =>
        sessionName == null ? jobs : jobs.filter((job) => job.sessionName === sessionName)
    },
    procRoot
  });
  return { monitor, procRoot, jobs };
}

const T0 = Date.parse("2026-07-20T12:00:00.000Z");

const turnTree: FakeProcProcess[] = [
  { pid: 100, ppid: 1, comm: "node", startTicks: 5000, utime: 1000, rssPages: 100 },
  { pid: 101, ppid: 100, comm: "python", startTicks: 5100, utime: 500, rssPages: 100 },
  { pid: 300, ppid: 1, comm: "unrelated", startTicks: 10, utime: 90_000, rssPages: 100 }
];

afterEach(() => {
  vi.useRealTimers();
});

describe("resource monitor", () => {
  it("computes exact interval-average cpu across two ticks over measured elapsed time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const session = makeSession({
      name: "chat-a",
      activeTurn: {
        id: "turn-1",
        state: "running",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pid: 100,
        processStartIdentity: "100:5000",
        outputChars: 0
      }
    });
    const { monitor, procRoot } = await makeMonitor({ sessions: [session] });
    try {
      await writeFakeProc(procRoot, turnTree, { cpu: [1000, 0, 1000, 8000, 0, 0, 0, 0] });
      await monitor.sampleOnce();

      // 30s later: pid 100 burned 600 ticks (20% of a core), pid 101 burned
      // 300 ticks (10%); host went 60% busy over the interval.
      await writeFakeProc(
        procRoot,
        [
          { ...turnTree[0]!, utime: 1600 },
          { ...turnTree[1]!, utime: 800 },
          turnTree[2]!
        ],
        { cpu: [2400, 0, 1400, 9200, 0, 0, 0, 0] }
      );
      vi.setSystemTime(T0 + 30_000);
      const payload = await monitor.sampleOnce();

      expect(payload?.supported).toBe(true);
      expect(payload?.sampledAt).toBe(new Date(T0 + 30_000).toISOString());
      const chatA = payload?.sessions.find((entry) => entry.name === "chat-a");
      expect(chatA?.cpuPct).toBe(30);
      expect(chatA?.rssBytes).toBe(2 * 100 * 4096);
      expect(chatA?.processCount).toBe(2);
      expect(chatA?.computeJobCount).toBe(0);
      // The unrelated tree stays out of every session and of the lab totals.
      expect(payload?.totals.cpuPct).toBe(30);
      expect(payload?.totals.processCount).toBe(2);
      // Host delta: 3000 total ticks, 1200 idle -> 60%.
      expect(payload?.host?.cpuPct).toBe(60);
      expect(payload?.host?.cpuCount).toBe(4);
    } finally {
      monitor.close();
    }
  });

  it("folds linked compute jobs into the session and rolls up unlinked jobs separately", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const session = makeSession({ name: "chat-a" });
    const jobs = [
      makeJob({
        id: "job-linked",
        sessionName: "chat-a",
        supervisorPid: 200,
        supervisorStartTicks: "7000",
        childPid: 201,
        childStartTicks: "7010"
      }),
      makeJob({
        id: "job-unlinked",
        supervisorPid: 400,
        supervisorStartTicks: "8000"
      })
    ];
    const { monitor, procRoot } = await makeMonitor({ sessions: [session], jobs });
    const processes: FakeProcProcess[] = [
      { pid: 200, ppid: 1, comm: "supervisor", startTicks: 7000, utime: 100, rssPages: 10 },
      { pid: 201, ppid: 200, comm: "bwrap", startTicks: 7010, utime: 100, rssPages: 10 },
      { pid: 202, ppid: 201, comm: "worker", startTicks: 7020, utime: 100, rssPages: 10 },
      { pid: 400, ppid: 1, comm: "loose", startTicks: 8000, utime: 100, rssPages: 20 }
    ];
    try {
      await writeFakeProc(procRoot, processes);
      await monitor.sampleOnce();
      await writeFakeProc(
        procRoot,
        processes.map((entry) => ({ ...entry, utime: (entry.utime ?? 0) + 300 }))
      );
      vi.setSystemTime(T0 + 30_000);
      const payload = await monitor.sampleOnce();

      const chatA = payload?.sessions.find((entry) => entry.name === "chat-a");
      // Three compute-tree processes at 10% each.
      expect(chatA?.cpuPct).toBe(30);
      expect(chatA?.processCount).toBe(3);
      expect(chatA?.computeJobCount).toBe(1);
      expect(payload?.unlinkedCompute).toMatchObject({
        jobCount: 1,
        cpuPct: 10,
        processCount: 1,
        rssBytes: 20 * 4096
      });
      expect(payload?.totals.cpuPct).toBe(40);
      expect(payload?.totals.processCount).toBe(4);
    } finally {
      monitor.close();
    }
  });

  it("skips turn and job anchors whose start-ticks identity does not match", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const session = makeSession({
      name: "chat-a",
      activeTurn: {
        id: "turn-1",
        state: "running",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pid: 100,
        // Recorded identity does not match the live process (PID was reused).
        processStartIdentity: "100:9999",
        outputChars: 0
      }
    });
    const jobs = [
      makeJob({
        id: "job-stale",
        sessionName: "chat-a",
        supervisorPid: 300,
        supervisorStartTicks: "1"
      })
    ];
    const { monitor, procRoot } = await makeMonitor({ sessions: [session], jobs });
    try {
      await writeFakeProc(procRoot, turnTree);
      const payload = await monitor.sampleOnce();
      const chatA = payload?.sessions.find((entry) => entry.name === "chat-a");
      expect(chatA).toMatchObject({ cpuPct: 0, rssBytes: 0, processCount: 0, computeJobCount: 1 });
      expect(payload?.totals.processCount).toBe(0);
    } finally {
      monitor.close();
    }
  });

  it("ignores turn pids when the turn is not in the running state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const session = makeSession({
      name: "chat-a",
      state: "completed",
      activeTurn: {
        id: "turn-1",
        state: "completed",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        pid: 100,
        processStartIdentity: "100:5000",
        outputChars: 0
      }
    });
    const { monitor, procRoot } = await makeMonitor({ sessions: [session] });
    try {
      await writeFakeProc(procRoot, turnTree);
      const payload = await monitor.sampleOnce();
      expect(payload?.sessions[0]).toMatchObject({ processCount: 0, state: "completed" });
    } finally {
      monitor.close();
    }
  });

  it("serves a fresh cached snapshot and resamples once it is stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { monitor, procRoot } = await makeMonitor({ sessions: [makeSession({ name: "chat-a" })] });
    try {
      await writeFakeProc(procRoot, turnTree);
      await monitor.sampleOnce();
      // Within 2x the sampling interval the cached tick is returned as-is.
      vi.setSystemTime(T0 + 45_000);
      const cached = await monitor.snapshot();
      expect(cached.sampledAt).toBe(new Date(T0).toISOString());
      // Beyond 2x the interval it samples on demand.
      vi.setSystemTime(T0 + 61_000);
      const resampled = await monitor.snapshot();
      expect(resampled.sampledAt).toBe(new Date(T0 + 61_000).toISOString());
    } finally {
      monitor.close();
    }
  });

  it("returns bucketed history with session filtering and validates the range", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const session = makeSession({
      name: "chat-a",
      activeTurn: {
        id: "turn-1",
        state: "running",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pid: 100,
        processStartIdentity: "100:5000",
        outputChars: 0
      }
    });
    const jobs = [
      makeJob({ id: "job-loose", supervisorPid: 400, supervisorStartTicks: "8000" })
    ];
    const { monitor, procRoot } = await makeMonitor({ sessions: [session], jobs });
    const withUnlinked: FakeProcProcess[] = [
      ...turnTree,
      { pid: 400, ppid: 1, comm: "loose", startTicks: 8000, utime: 100, rssPages: 20 }
    ];
    try {
      await writeFakeProc(procRoot, withUnlinked);
      await monitor.sampleOnce();
      await writeFakeProc(
        procRoot,
        withUnlinked.map((entry) =>
          entry.pid === 300 ? entry : { ...entry, utime: (entry.utime ?? 0) + 300 }
        )
      );
      vi.setSystemTime(T0 + 30_000);
      await monitor.sampleOnce();

      const history = monitor.history({
        since: new Date(T0 - 30_000).toISOString(),
        until: new Date(T0 + 60_000).toISOString(),
        bucketSeconds: 120
      });
      expect(history.bucketSeconds).toBe(120);
      expect(history.retentionDays).toBe(7);
      expect(history.samplingIntervalMs).toBe(30_000);
      const chatA = history.sessions.find((entry) => entry.name === "chat-a");
      expect(chatA?.kind).toBe("session");
      expect(chatA?.points).toHaveLength(1);
      expect(chatA?.points[0]?.samples).toBe(2);
      expect(chatA?.points[0]?.maxCpuPct).toBe(20);
      expect(chatA?.points[0]?.topProcesses.length).toBeGreaterThan(0);
      const unlinked = history.sessions.find((entry) => entry.kind === "unlinked");
      expect(unlinked?.name).toBe("");
      expect(history.host).toHaveLength(1);
      expect(history.host[0]?.samples).toBe(2);
      expect(history.totals).toHaveLength(1);
      expect(history.totals[0]?.samples).toBe(2);

      const filtered = monitor.history({
        since: new Date(T0 - 30_000).toISOString(),
        until: new Date(T0 + 60_000).toISOString(),
        bucketSeconds: 120,
        session: "chat-a"
      });
      expect(filtered.sessions).toHaveLength(1);
      expect(filtered.sessions[0]?.name).toBe("chat-a");

      expect(() =>
        monitor.history({
          since: new Date(T0 + 60_000).toISOString(),
          until: new Date(T0 - 30_000).toISOString()
        })
      ).toThrow(/since must be earlier/u);
      expect(() => monitor.history({ since: "not-a-date" })).toThrow(/Invalid history since/u);
    } finally {
      monitor.close();
    }
  });
});
