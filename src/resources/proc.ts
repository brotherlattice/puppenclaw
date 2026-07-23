import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Linux USER_HZ. All /proc cpu counters are cumulative jiffies at this rate. */
export const TICKS_PER_SECOND = 100;
/** Page size used to convert the /proc stat `rss` field (pages) to bytes. */
export const PAGE_SIZE_BYTES = 4096;

export type ProcProcess = {
  pid: number;
  ppid: number;
  /** Process comm (the parenthesised field 2 of /proc/[pid]/stat). */
  name: string;
  /** Field 22 of /proc/[pid]/stat: process start time in ticks since boot. */
  startTicks: string;
  /** Cumulative utime+stime jiffies. */
  cpuTicks: number;
  rssBytes: number;
};

export type HostCpuSample = {
  /** Sum of the cumulative jiffies of every column of the aggregate `cpu` line. */
  totalTicks: number;
  /** idle + iowait cumulative jiffies. */
  idleTicks: number;
  cpuCount: number;
};

export type HostMemInfo = {
  memTotalBytes: number;
  memAvailableBytes: number;
};

export type HostLoadAvg = {
  load1: number;
  load5: number;
  load15: number;
};

export type ProcSnapshot = {
  /** Epoch-ms wall clock time the snapshot was taken. */
  sampledAtMs: number;
  /** Seconds since boot per /proc/uptime (0 when unreadable). */
  uptimeSeconds: number;
  /** All readable processes keyed by pid. */
  processes: Map<number, ProcProcess>;
  hostCpu: HostCpuSample | null;
  memInfo: HostMemInfo | null;
  loadAvg: HostLoadAvg | null;
};

/** PID-reuse-safe process identity, matching the convention used elsewhere in the repo. */
export function processIdentityKey(pid: number, startTicks: string): string {
  return `${pid}:${startTicks}`;
}

export function parseProcPidStat(pid: number, raw: string): ProcProcess | null {
  // comm may contain spaces and parentheses; the closing paren of the comm
  // field is always the LAST ")" in the line.
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close < 0 || close < open) return null;
  const name = raw.slice(open + 1, close);
  const fields = raw
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  // fields[0] is the state field (field 3 of stat(5)); ppid=fields[1],
  // utime=fields[11], stime=fields[12], starttime=fields[19], rss=fields[21].
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const startTicks = fields[19];
  const rssPages = Number(fields[21]);
  if (!Number.isFinite(ppid) || startTicks == null) return null;
  return {
    pid,
    ppid,
    name,
    startTicks,
    cpuTicks: (Number.isFinite(utime) ? utime : 0) + (Number.isFinite(stime) ? stime : 0),
    rssBytes: (Number.isFinite(rssPages) ? rssPages : 0) * PAGE_SIZE_BYTES
  };
}

export function parseHostCpu(raw: string): HostCpuSample | null {
  const lines = raw.split("\n");
  const aggregate = lines.find((line) => /^cpu\s/u.test(line));
  if (aggregate == null) return null;
  const columns = aggregate.trim().split(/\s+/u).slice(1).map(Number);
  if (columns.length < 4 || columns.some((value) => !Number.isFinite(value))) return null;
  const idle = (columns[3] ?? 0) + (columns[4] ?? 0);
  const total = columns.reduce((sum, value) => sum + value, 0);
  const cpuCount = lines.filter((line) => /^cpu\d+\s/u.test(line)).length;
  return { totalTicks: total, idleTicks: idle, cpuCount: Math.max(cpuCount, 1) };
}

export function parseMemInfo(raw: string): HostMemInfo | null {
  const total = /^MemTotal:\s+(\d+)\s+kB$/mu.exec(raw);
  const available = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(raw);
  if (total == null || available == null) return null;
  return {
    memTotalBytes: Number(total[1]) * 1024,
    memAvailableBytes: Number(available[1]) * 1024
  };
}

export function parseLoadAvg(raw: string): HostLoadAvg | null {
  const fields = raw.trim().split(/\s+/u);
  const load1 = Number(fields[0]);
  const load5 = Number(fields[1]);
  const load15 = Number(fields[2]);
  if (![load1, load5, load15].every((value) => Number.isFinite(value))) return null;
  return { load1, load5, load15 };
}

export function parseUptimeSeconds(raw: string): number {
  const value = Number(raw.trim().split(/\s+/u)[0]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * One pass over `/proc/[0-9]+/stat` plus the host-wide files. Every per-pid
 * read is `.catch(() => null)` so processes that vanish mid-sample are simply
 * dropped instead of failing the snapshot.
 */
export async function readProcSnapshot(procRoot = "/proc"): Promise<ProcSnapshot> {
  const sampledAtMs = Date.now();
  const entries = await readdir(procRoot).catch(() => [] as string[]);
  const pids = entries.filter((entry) => /^[0-9]+$/u.test(entry)).map(Number);
  const [stats, hostCpuRaw, uptimeRaw, memInfoRaw, loadAvgRaw] = await Promise.all([
    Promise.all(
      pids.map((pid) =>
        readFile(join(procRoot, String(pid), "stat"), "utf8")
          .then((raw) => parseProcPidStat(pid, raw))
          .catch(() => null)
      )
    ),
    readFile(join(procRoot, "stat"), "utf8").catch(() => null),
    readFile(join(procRoot, "uptime"), "utf8").catch(() => null),
    readFile(join(procRoot, "meminfo"), "utf8").catch(() => null),
    readFile(join(procRoot, "loadavg"), "utf8").catch(() => null)
  ]);
  const processes = new Map<number, ProcProcess>();
  for (const parsed of stats) {
    if (parsed != null) processes.set(parsed.pid, parsed);
  }
  return {
    sampledAtMs,
    uptimeSeconds: uptimeRaw != null ? parseUptimeSeconds(uptimeRaw) : 0,
    processes,
    hostCpu: hostCpuRaw != null ? parseHostCpu(hostCpuRaw) : null,
    memInfo: memInfoRaw != null ? parseMemInfo(memInfoRaw) : null,
    loadAvg: loadAvgRaw != null ? parseLoadAvg(loadAvgRaw) : null
  };
}

/**
 * Ancestry-only tree walk: BFS over a ppid -> children index starting from
 * `roots`, returning the set of pids reachable through parent links (roots
 * included when present in the snapshot).
 *
 * IMPORTANT: this deliberately never filters by process group (pgrp/pgid).
 * Process-group ids collide: unrelated process trees can share a pgid (e.g.
 * shells re-using a terminated leader's pgid, or daemons calling setpgid), so
 * pgid-based matching folds foreign processes into the wrong session. Ancestry
 * via ppid cannot produce such false positives.
 *
 * Known limitation: a double-forked daemon whose parent exits gets reparented
 * to init/subreaper and escapes this walk. Cgroup-based accounting (deferred)
 * is the eventual fix for that class of processes.
 */
export function collectDescendants(
  roots: Iterable<number>,
  processes: ReadonlyMap<number, ProcProcess>
): Set<number> {
  const childrenByPpid = new Map<number, number[]>();
  for (const process of processes.values()) {
    const siblings = childrenByPpid.get(process.ppid);
    if (siblings == null) {
      childrenByPpid.set(process.ppid, [process.pid]);
    } else {
      siblings.push(process.pid);
    }
  }
  const members = new Set<number>();
  const queue: number[] = [];
  for (const root of roots) {
    if (processes.has(root) && !members.has(root)) {
      members.add(root);
      queue.push(root);
    }
  }
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of childrenByPpid.get(pid) ?? []) {
      if (!members.has(child)) {
        members.add(child);
        queue.push(child);
      }
    }
  }
  return members;
}

/**
 * CPU% of one core for a process between two samples:
 * `100 * deltaTicks / (TICKS_PER_SECOND * elapsedSeconds)`.
 *
 * `prevCpuTicks` must come from a prev map keyed `${pid}:${startTicks}` so a
 * reused pid (same pid, different start ticks) is treated as first-seen. A
 * first-seen process falls back to its lifetime average computed from
 * /proc/uptime and its start ticks.
 */
export function diffProcessCpu(params: {
  process: ProcProcess;
  prevCpuTicks: number | null;
  elapsedSeconds: number | null;
  uptimeSeconds: number;
}): number {
  const { process, prevCpuTicks, elapsedSeconds, uptimeSeconds } = params;
  if (prevCpuTicks != null && elapsedSeconds != null && elapsedSeconds > 0) {
    const deltaTicks = Math.max(0, process.cpuTicks - prevCpuTicks);
    return (100 * deltaTicks) / (TICKS_PER_SECOND * elapsedSeconds);
  }
  const startSeconds = Number(process.startTicks) / TICKS_PER_SECOND;
  const ageSeconds = uptimeSeconds - (Number.isFinite(startSeconds) ? startSeconds : 0);
  if (!(ageSeconds > 0)) return 0;
  return (100 * process.cpuTicks) / (TICKS_PER_SECOND * ageSeconds);
}

/** Machine-wide host CPU% (0-100) between two /proc/stat samples. */
export function diffHostCpu(prev: HostCpuSample, current: HostCpuSample): number {
  const deltaTotal = current.totalTicks - prev.totalTicks;
  const deltaIdle = current.idleTicks - prev.idleTicks;
  if (!(deltaTotal > 0)) return 0;
  return Math.min(100, Math.max(0, (100 * (deltaTotal - deltaIdle)) / deltaTotal));
}
