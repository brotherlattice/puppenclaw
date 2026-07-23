import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { ComputeJobRecord } from "../compute/types.js";
import { PuppenclawError } from "../shared/errors.js";
import type { PluginLogger } from "../shared/logger.js";
import type { SessionStore } from "../shared/store.js";
import type { ParsedPluginConfig, SessionInfo } from "../shared/types.js";
import {
  collectDescendants,
  diffHostCpu,
  diffProcessCpu,
  processIdentityKey,
  readProcSnapshot,
  type HostCpuSample,
  type ProcProcess,
  type ProcSnapshot
} from "./proc.js";
import { ResourceStore, type HostSampleRow, type ResourceSampleRow } from "./store.js";
import type {
  HostSnapshot,
  ResourcesHistoryParams,
  ResourcesHistoryPayload,
  ResourcesSnapshotPayload,
  SessionProcessesPayload,
  SessionProcessInfo,
  SessionUsageSnapshot,
  TopProcessSummary
} from "./types.js";

/** Window of the on-demand live `/session/:name/processes` double sample. */
const LIVE_SAMPLE_WINDOW_MS = 400;
const PRUNE_INTERVAL_MS = 3_600_000;
const DEFAULT_HISTORY_WINDOW_MS = 24 * 3_600_000;
const DEFAULT_MAX_POINTS_PER_SERIES = 500;
const TOP_PROCESS_COUNT = 5;
const DAY_MS = 86_400_000;

export type ComputeJobsProvider = {
  listActive(sessionName?: string): ComputeJobRecord[] | Promise<ComputeJobRecord[]>;
};

type TreeUsage = {
  cpuPct: number;
  rssBytes: number;
  processCount: number;
  topProcesses: TopProcessSummary[];
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function zeroTotals(): { cpuPct: number; rssBytes: number; processCount: number } {
  return { cpuPct: 0, rssBytes: 0, processCount: 0 };
}

/**
 * Returns `pid` only when the live snapshot still shows the same start-ticks
 * identity that was recorded when the process was spawned (PID-reuse guard).
 */
function verifiedPid(
  snapshot: ProcSnapshot,
  pid: number | null,
  startTicks: string | null
): number | null {
  if (pid == null || startTicks == null) return null;
  return snapshot.processes.get(pid)?.startTicks === startTicks ? pid : null;
}

/**
 * A session's turn pid is only used as a tree root while the turn metadata
 * says the turn is running AND the pid's observed `${pid}:${startTicks}`
 * identity matches the recorded `processStartIdentity`.
 */
function verifiedTurnPid(snapshot: ProcSnapshot, session: SessionInfo): number | null {
  const turn = session.activeTurn;
  if (turn == null || turn.state !== "running") return null;
  if (turn.pid == null || turn.processStartIdentity == null) return null;
  const observed = snapshot.processes.get(turn.pid);
  if (observed == null) return null;
  return processIdentityKey(turn.pid, observed.startTicks) === turn.processStartIdentity
    ? turn.pid
    : null;
}

function verifiedComputeRoots(snapshot: ProcSnapshot, jobs: readonly ComputeJobRecord[]): number[] {
  const roots: number[] = [];
  for (const job of jobs) {
    const supervisor = verifiedPid(snapshot, job.supervisorPid, job.supervisorStartTicks);
    if (supervisor != null) roots.push(supervisor);
    const child = verifiedPid(snapshot, job.childPid, job.childStartTicks);
    if (child != null) roots.push(child);
  }
  return roots;
}

/**
 * ~30s /proc sampler + 7-day SQLite history buffer + live process inspection.
 * Runs daemon-side only. `procRoot` is injectable for tests.
 */
export class ResourceMonitor {
  private readonly samplingIntervalMs: number;
  private readonly retentionDays: number;
  private readonly procRoot: string;
  private readonly supported: boolean;
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  /** Cumulative cpu ticks of the previous tick, keyed `${pid}:${startTicks}`. */
  private prevCpuTicks = new Map<string, number>();
  private prevSampledAtMs: number | null = null;
  private prevHostCpu: HostCpuSample | null = null;
  private lastSnapshot: ResourcesSnapshotPayload | null = null;
  private lastSnapshotAtMs = 0;
  private lastPruneAtMs = 0;

  private constructor(
    private readonly store: ResourceStore,
    private readonly logger: PluginLogger,
    private readonly sessionStore: SessionStore,
    private readonly computeJobs: ComputeJobsProvider,
    config: ParsedPluginConfig,
    procRoot: string
  ) {
    this.samplingIntervalMs = config.resourceSamplingIntervalMs;
    this.retentionDays = config.resourceRetentionDays;
    this.procRoot = procRoot;
    this.supported = process.platform === "linux";
  }

  static async open(params: {
    dataDir: string;
    config: ParsedPluginConfig;
    logger: PluginLogger;
    sessionStore: SessionStore;
    computeJobs: ComputeJobsProvider;
    procRoot?: string;
  }): Promise<ResourceMonitor> {
    const store = await ResourceStore.open(join(params.dataDir, "resources"));
    return new ResourceMonitor(
      store,
      params.logger,
      params.sessionStore,
      params.computeJobs,
      params.config,
      params.procRoot ?? "/proc"
    );
  }

  start(): void {
    if (!this.supported) {
      this.logger.warn("Resource monitor is disabled: /proc-based sampling requires Linux.");
      return;
    }
    if (this.timer != null) return;
    this.timer = setInterval(() => {
      void this.runTick();
    }, this.samplingIntervalMs);
    this.timer.unref();
    void this.runTick();
  }

  close(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.store.close();
  }

  private async runTick(): Promise<void> {
    try {
      await this.sampleOnce();
    } catch (error) {
      this.logger.warn(
        `Resource monitor tick failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * One sampler tick: snapshot /proc, walk ancestry trees for every session
   * and compute job, derive interval-average CPU% from cumulative-jiffies
   * deltas over the MEASURED elapsed time since the previous tick, persist all
   * rows under one shared epoch-ms ts, and hourly-prune expired history.
   */
  async sampleOnce(): Promise<ResourcesSnapshotPayload | null> {
    if (!this.supported) return null;
    // Re-entrancy guard: a slow tick must never interleave with the next one
    // (the prev-map delta math assumes strictly sequential samples).
    if (this.sampling) return this.lastSnapshot;
    this.sampling = true;
    try {
      const snapshot = await readProcSnapshot(this.procRoot);
      const sessions = this.sessionStore.listSessions();
      const jobs = await this.computeJobs.listActive();
      const elapsedSeconds =
        this.prevSampledAtMs != null ? (snapshot.sampledAtMs - this.prevSampledAtMs) / 1000 : null;
      const prev = this.prevCpuTicks;
      const cpuFor = (proc: ProcProcess): number =>
        diffProcessCpu({
          process: proc,
          prevCpuTicks: prev.get(processIdentityKey(proc.pid, proc.startTicks)) ?? null,
          elapsedSeconds,
          uptimeSeconds: snapshot.uptimeSeconds
        });

      const jobsBySession = new Map<string, ComputeJobRecord[]>();
      const unlinkedJobs: ComputeJobRecord[] = [];
      for (const job of jobs) {
        if (job.sessionName == null) {
          unlinkedJobs.push(job);
          continue;
        }
        const linked = jobsBySession.get(job.sessionName);
        if (linked == null) {
          jobsBySession.set(job.sessionName, [job]);
        } else {
          linked.push(job);
        }
      }

      const rows: ResourceSampleRow[] = [];
      const sessionSnapshots: SessionUsageSnapshot[] = [];
      for (const session of sessions) {
        const linkedJobs = jobsBySession.get(session.name) ?? [];
        const usage = measureTree({
          snapshot,
          turnPid: verifiedTurnPid(snapshot, session),
          computeRoots: verifiedComputeRoots(snapshot, linkedJobs),
          cpuFor
        });
        rows.push({
          sessionName: session.name,
          kind: "session",
          state: session.state,
          cpuPct: usage.cpuPct,
          rssBytes: usage.rssBytes,
          processCount: usage.processCount,
          topProcesses: usage.topProcesses
        });
        sessionSnapshots.push({
          name: session.name,
          state: session.state,
          cpuPct: usage.cpuPct,
          rssBytes: usage.rssBytes,
          processCount: usage.processCount,
          computeJobCount: linkedJobs.length
        });
      }
      const unlinkedUsage = measureTree({
        snapshot,
        turnPid: null,
        computeRoots: verifiedComputeRoots(snapshot, unlinkedJobs),
        cpuFor
      });
      if (unlinkedJobs.length > 0 || unlinkedUsage.processCount > 0) {
        rows.push({
          sessionName: "",
          kind: "unlinked",
          state: "active",
          cpuPct: unlinkedUsage.cpuPct,
          rssBytes: unlinkedUsage.rssBytes,
          processCount: unlinkedUsage.processCount,
          topProcesses: unlinkedUsage.topProcesses
        });
      }

      let host: HostSnapshot | null = null;
      let hostRow: HostSampleRow | null = null;
      if (snapshot.hostCpu != null && snapshot.memInfo != null && snapshot.loadAvg != null) {
        // First tick has no previous host sample; diffing against zero
        // counters yields the since-boot lifetime average as fallback.
        const hostCpuPct = round2(
          diffHostCpu(
            this.prevHostCpu ?? { totalTicks: 0, idleTicks: 0, cpuCount: snapshot.hostCpu.cpuCount },
            snapshot.hostCpu
          )
        );
        host = {
          cpuPct: hostCpuPct,
          cpuCount: snapshot.hostCpu.cpuCount,
          memTotalBytes: snapshot.memInfo.memTotalBytes,
          memAvailableBytes: snapshot.memInfo.memAvailableBytes,
          load1: snapshot.loadAvg.load1,
          load5: snapshot.loadAvg.load5,
          load15: snapshot.loadAvg.load15
        };
        hostRow = {
          cpuPct: hostCpuPct,
          cpuCount: snapshot.hostCpu.cpuCount,
          memTotalBytes: snapshot.memInfo.memTotalBytes,
          memAvailableBytes: snapshot.memInfo.memAvailableBytes,
          load1: snapshot.loadAvg.load1,
          load5: snapshot.loadAvg.load5,
          load15: snapshot.loadAvg.load15
        };
      }

      this.store.insertTick(snapshot.sampledAtMs, rows, hostRow);
      if (snapshot.sampledAtMs - this.lastPruneAtMs >= PRUNE_INTERVAL_MS) {
        this.lastPruneAtMs = snapshot.sampledAtMs;
        const deleted = this.store.prune(snapshot.sampledAtMs - this.retentionDays * DAY_MS);
        if (deleted > 0) {
          this.logger.info(`Resource monitor pruned ${deleted} expired history rows.`);
        }
      }

      // Prev map is rebuilt (= pruned) every tick so vanished pids drop out
      // and reused pids (different start ticks) never inherit stale counters.
      const nextPrev = new Map<string, number>();
      for (const proc of snapshot.processes.values()) {
        nextPrev.set(processIdentityKey(proc.pid, proc.startTicks), proc.cpuTicks);
      }
      this.prevCpuTicks = nextPrev;
      this.prevSampledAtMs = snapshot.sampledAtMs;
      this.prevHostCpu = snapshot.hostCpu;

      const totals = zeroTotals();
      for (const entry of sessionSnapshots) {
        totals.cpuPct += entry.cpuPct;
        totals.rssBytes += entry.rssBytes;
        totals.processCount += entry.processCount;
      }
      totals.cpuPct = round2(totals.cpuPct + unlinkedUsage.cpuPct);
      totals.rssBytes += unlinkedUsage.rssBytes;
      totals.processCount += unlinkedUsage.processCount;

      const payload: ResourcesSnapshotPayload = {
        sampledAt: new Date(snapshot.sampledAtMs).toISOString(),
        samplingIntervalMs: this.samplingIntervalMs,
        supported: true,
        host,
        sessions: sessionSnapshots,
        unlinkedCompute: {
          jobCount: unlinkedJobs.length,
          cpuPct: unlinkedUsage.cpuPct,
          rssBytes: unlinkedUsage.rssBytes,
          processCount: unlinkedUsage.processCount
        },
        totals
      };
      this.lastSnapshot = payload;
      this.lastSnapshotAtMs = snapshot.sampledAtMs;
      return payload;
    } finally {
      this.sampling = false;
    }
  }

  /** Last sampler tick if still fresh (< 2x interval), else samples on demand. */
  async snapshot(): Promise<ResourcesSnapshotPayload> {
    if (!this.supported) return this.emptySnapshot(false);
    if (
      this.lastSnapshot != null &&
      Date.now() - this.lastSnapshotAtMs < 2 * this.samplingIntervalMs
    ) {
      return this.lastSnapshot;
    }
    return (await this.sampleOnce()) ?? this.lastSnapshot ?? this.emptySnapshot(true);
  }

  private emptySnapshot(supported: boolean): ResourcesSnapshotPayload {
    return {
      sampledAt: new Date().toISOString(),
      samplingIntervalMs: this.samplingIntervalMs,
      supported,
      host: null,
      sessions: [],
      unlinkedCompute: { jobCount: 0, cpuPct: 0, rssBytes: 0, processCount: 0 },
      totals: zeroTotals()
    };
  }

  /**
   * Live process inspection: its own 2-sample ~400ms window, fully independent
   * of the periodic sampler's prev-map state.
   */
  async sessionProcesses(name: string): Promise<SessionProcessesPayload> {
    const session = this.sessionStore.getSession(name);
    if (session == null) {
      throw new PuppenclawError("NO_SESSION", `Unknown session ${name}.`, { name });
    }
    if (!this.supported) {
      return {
        name,
        sampledAt: new Date().toISOString(),
        sampleWindowMs: 0,
        supported: false,
        roots: { turnPid: null, computeJobs: [] },
        processes: [],
        totals: zeroTotals()
      };
    }
    const jobs = await this.computeJobs.listActive(name);
    const first = await readProcSnapshot(this.procRoot);
    await sleep(LIVE_SAMPLE_WINDOW_MS);
    const second = await readProcSnapshot(this.procRoot);
    const elapsedSeconds = (second.sampledAtMs - first.sampledAtMs) / 1000;
    const prevTicks = new Map<string, number>();
    for (const proc of first.processes.values()) {
      prevTicks.set(processIdentityKey(proc.pid, proc.startTicks), proc.cpuTicks);
    }
    const turnPid = verifiedTurnPid(second, session);
    const computeRoots = verifiedComputeRoots(second, jobs);
    const members = collectDescendants(
      turnPid != null ? [turnPid, ...computeRoots] : computeRoots,
      second.processes
    );
    const computeMembers = collectDescendants(computeRoots, second.processes);
    const processes: SessionProcessInfo[] = [];
    const totals = zeroTotals();
    for (const pid of members) {
      const proc = second.processes.get(pid);
      if (proc == null) continue;
      const cpuPct = round2(
        diffProcessCpu({
          process: proc,
          prevCpuTicks: prevTicks.get(processIdentityKey(proc.pid, proc.startTicks)) ?? null,
          elapsedSeconds,
          uptimeSeconds: second.uptimeSeconds
        })
      );
      processes.push({
        pid: proc.pid,
        ppid: proc.ppid,
        name: proc.name,
        cpuPct,
        rssBytes: proc.rssBytes,
        kind: computeMembers.has(pid) ? "compute" : "turn"
      });
      totals.cpuPct += cpuPct;
      totals.rssBytes += proc.rssBytes;
      totals.processCount += 1;
    }
    totals.cpuPct = round2(totals.cpuPct);
    processes.sort((left, right) => right.cpuPct - left.cpuPct);
    return {
      name,
      sampledAt: new Date(second.sampledAtMs).toISOString(),
      sampleWindowMs: Math.max(0, second.sampledAtMs - first.sampledAtMs),
      supported: true,
      roots: {
        turnPid,
        computeJobs: jobs.map((job) => ({
          jobId: job.id,
          supervisorPid: verifiedPid(second, job.supervisorPid, job.supervisorStartTicks),
          childPid: verifiedPid(second, job.childPid, job.childStartTicks)
        }))
      },
      processes,
      totals
    };
  }

  history(params: ResourcesHistoryParams): ResourcesHistoryPayload {
    const untilMs = params.until != null ? Date.parse(params.until) : Date.now();
    if (!Number.isFinite(untilMs)) {
      throw new Error(`Invalid history until timestamp: ${params.until}`);
    }
    const sinceMs =
      params.since != null ? Date.parse(params.since) : untilMs - DEFAULT_HISTORY_WINDOW_MS;
    if (!Number.isFinite(sinceMs)) {
      throw new Error(`Invalid history since timestamp: ${params.since}`);
    }
    if (sinceMs >= untilMs) {
      throw new Error("History range is empty: since must be earlier than until.");
    }
    const bucketSeconds = params.bucketSeconds ?? this.defaultBucketSeconds(untilMs - sinceMs);
    const query = { sinceMs, untilMs, bucketMs: bucketSeconds * 1000 };
    const sessions = this.store.sessionSeries({
      ...query,
      ...(params.session != null ? { sessionName: params.session } : {})
    });
    return {
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      bucketSeconds,
      samplingIntervalMs: this.samplingIntervalMs,
      retentionDays: this.retentionDays,
      sessions: sessions.map((series) => ({
        name: series.name,
        kind: series.kind,
        points: series.points.map(({ tsMs, ...point }) => ({
          ts: new Date(tsMs).toISOString(),
          ...point
        }))
      })),
      host: this.store.hostSeries(query).map(({ tsMs, ...point }) => ({
        ts: new Date(tsMs).toISOString(),
        ...point
      })),
      totals: this.store.totalsSeries(query).map(({ tsMs, ...point }) => ({
        ts: new Date(tsMs).toISOString(),
        ...point
      }))
    };
  }

  private defaultBucketSeconds(durationMs: number): number {
    const intervalSeconds = Math.max(1, Math.round(this.samplingIntervalMs / 1000));
    return Math.max(Math.ceil(durationMs / 1000 / DEFAULT_MAX_POINTS_PER_SERIES), intervalSeconds);
  }
}

function measureTree(params: {
  snapshot: ProcSnapshot;
  turnPid: number | null;
  computeRoots: number[];
  cpuFor: (proc: ProcProcess) => number;
}): TreeUsage {
  const roots =
    params.turnPid != null ? [params.turnPid, ...params.computeRoots] : params.computeRoots;
  const members = collectDescendants(roots, params.snapshot.processes);
  let cpuPct = 0;
  let rssBytes = 0;
  const measured: Array<{ proc: ProcProcess; cpuPct: number }> = [];
  for (const pid of members) {
    const proc = params.snapshot.processes.get(pid);
    if (proc == null) continue;
    const processCpu = params.cpuFor(proc);
    cpuPct += processCpu;
    rssBytes += proc.rssBytes;
    measured.push({ proc, cpuPct: processCpu });
  }
  measured.sort((left, right) => right.cpuPct - left.cpuPct);
  return {
    cpuPct: round2(cpuPct),
    rssBytes,
    processCount: measured.length,
    topProcesses: measured.slice(0, TOP_PROCESS_COUNT).map(({ proc, cpuPct: processCpu }) => ({
      name: proc.name,
      cpuPct: round2(processCpu),
      rssBytes: proc.rssBytes
    }))
  };
}
