import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type FakeProcProcess = {
  pid: number;
  ppid: number;
  comm: string;
  pgrp?: number;
  startTicks?: number;
  utime?: number;
  stime?: number;
  rssPages?: number;
};

export type FakeProcHost = {
  /** Cumulative jiffies for the aggregate cpu line: user nice system idle iowait irq softirq steal. */
  cpu?: [number, number, number, number, number, number, number, number];
  cpuCount?: number;
  uptimeSeconds?: number;
  memTotalKiB?: number;
  memAvailableKiB?: number;
  loadAvg?: [number, number, number];
};

export function fakeStatLine(process: FakeProcProcess): string {
  const pgrp = process.pgrp ?? process.pid;
  const utime = process.utime ?? 0;
  const stime = process.stime ?? 0;
  const startTicks = process.startTicks ?? 1000;
  const rssPages = process.rssPages ?? 0;
  // stat(5) fields 3..24: state ppid pgrp session tty_nr tpgid flags minflt
  // cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads
  // itrealvalue starttime vsize rss rsslim
  return `${process.pid} (${process.comm}) S ${process.ppid} ${pgrp} ${pgrp} 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ${startTicks} 1000000 ${rssPages} 18446744073709551615\n`;
}

/**
 * Writes a fake /proc tree (per-pid stat files plus host stat/uptime/meminfo/
 * loadavg) under `procRoot`, replacing whatever was there before.
 */
export async function writeFakeProc(
  procRoot: string,
  processes: readonly FakeProcProcess[],
  host: FakeProcHost = {}
): Promise<void> {
  await rm(procRoot, { recursive: true, force: true });
  await mkdir(procRoot, { recursive: true });
  for (const process of processes) {
    const pidDir = join(procRoot, String(process.pid));
    await mkdir(pidDir, { recursive: true });
    await writeFile(join(pidDir, "stat"), fakeStatLine(process), "utf8");
  }
  const cpu = host.cpu ?? [1000, 0, 1000, 8000, 0, 0, 0, 0];
  const cpuCount = host.cpuCount ?? 4;
  const cpuLines = [`cpu  ${cpu.join(" ")}`];
  for (let index = 0; index < cpuCount; index += 1) {
    cpuLines.push(`cpu${index}  ${cpu.map((value) => Math.floor(value / cpuCount)).join(" ")}`);
  }
  await writeFile(join(procRoot, "stat"), `${cpuLines.join("\n")}\n`, "utf8");
  const uptime = host.uptimeSeconds ?? 1000;
  await writeFile(join(procRoot, "uptime"), `${uptime.toFixed(2)} ${uptime.toFixed(2)}\n`, "utf8");
  const memTotalKiB = host.memTotalKiB ?? 16_000_000;
  const memAvailableKiB = host.memAvailableKiB ?? 8_000_000;
  await writeFile(
    join(procRoot, "meminfo"),
    `MemTotal:       ${memTotalKiB} kB\nMemFree:        ${memAvailableKiB} kB\nMemAvailable:   ${memAvailableKiB} kB\n`,
    "utf8"
  );
  const [load1, load5, load15] = host.loadAvg ?? [0.5, 0.4, 0.3];
  await writeFile(join(procRoot, "loadavg"), `${load1} ${load5} ${load15} 1/100 999\n`, "utf8");
}
