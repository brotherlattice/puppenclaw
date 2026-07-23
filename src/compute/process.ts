import { readFile } from "node:fs/promises";

export async function readProcessStartTicks(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    const fieldsAfterComm = stat.slice(closeParen + 2).trim().split(/\s+/u);
    return fieldsAfterComm[19] ?? null;
  } catch {
    return null;
  }
}

export async function processIdentityMatches(
  pid: number | null,
  startTicks: string | null
): Promise<boolean> {
  if (pid == null || startTicks == null) return false;
  return (await readProcessStartTicks(pid)) === startTicks;
}

export async function readProcessUsage(pid: number): Promise<{
  peakMemoryKiB: number | null;
  cpuSeconds: number | null;
  readBytes: number | null;
  writeBytes: number | null;
}> {
  const [status, stat, io] = await Promise.all([
    readFile(`/proc/${pid}/status`, "utf8").catch(() => ""),
    readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""),
    readFile(`/proc/${pid}/io`, "utf8").catch(() => "")
  ]);
  const peakMatch = /^VmHWM:\s+(\d+)\s+kB$/mu.exec(status);
  const closeParen = stat.lastIndexOf(")");
  const fields = closeParen >= 0 ? stat.slice(closeParen + 2).trim().split(/\s+/u) : [];
  const ticksPerSecond = 100;
  const userTicks = Number(fields[11] ?? Number.NaN);
  const systemTicks = Number(fields[12] ?? Number.NaN);
  const readMatch = /^read_bytes:\s+(\d+)$/mu.exec(io);
  const writeMatch = /^write_bytes:\s+(\d+)$/mu.exec(io);
  return {
    peakMemoryKiB: peakMatch ? Number(peakMatch[1]) : null,
    cpuSeconds:
      Number.isFinite(userTicks) && Number.isFinite(systemTicks)
        ? (userTicks + systemTicks) / ticksPerSecond
        : null,
    readBytes: readMatch ? Number(readMatch[1]) : null,
    writeBytes: writeMatch ? Number(writeMatch[1]) : null
  };
}

