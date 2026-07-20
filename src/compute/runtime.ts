import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ParsedPluginConfig } from "../shared/types.js";
import { ensureDir, readJsonFile, writeJsonFileAtomic } from "../shared/utils.js";
import { computeExecutorCapabilities } from "./capabilities.js";
import { processIdentityMatches, readProcessStartTicks } from "./process.js";
import { ComputeStore } from "./store.js";
import {
  computeJobRecordZod,
  computeJobSpecZod,
  type ComputeJobRecord,
  type ComputeJobSpec
} from "./types.js";

const ACTIVE_STATES = new Set(["queued", "starting", "running"]);

export function isPathWithinRoots(candidate: string, roots: readonly string[]): boolean {
  const resolvedCandidate = resolve(candidate);
  return roots.some((root) => {
    const resolvedRoot = resolve(root);
    return (
      resolvedCandidate === resolvedRoot ||
      resolvedCandidate.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`)
    );
  });
}

export class ComputeRuntime {
  private constructor(
    private readonly store: ComputeStore,
    private readonly rootDir: string,
    private readonly allowedRoots: string[],
    private readonly supervisorPath: string
  ) {}

  static async open(params: {
    dataDir: string;
    config: ParsedPluginConfig;
    supervisorPath?: string;
  }): Promise<ComputeRuntime> {
    const rootDir = join(params.dataDir, "compute");
    await ensureDir(join(rootDir, "jobs"));
    const configuredRoots = [
      ...params.config.orchestration.localWorker.projectRoots,
      ...(params.config.orchestration.defaultProjectRoot
        ? [params.config.orchestration.defaultProjectRoot]
        : [])
    ];
    const allowedRoots = await Promise.all(
      [...new Set(configuredRoots.map((root) => resolve(root)))].map((root) =>
        realpath(root).catch(() => root)
      )
    );
    const supervisorPath =
      params.supervisorPath ??
      fileURLToPath(new URL("../compute/supervisor-cli.js", import.meta.url));
    const runtime = new ComputeRuntime(
      await ComputeStore.open(rootDir),
      rootDir,
      allowedRoots,
      supervisorPath
    );
    await runtime.reconcileAll();
    return runtime;
  }

  close(): void {
    this.store.close();
  }

  capacity() {
    return { executors: computeExecutorCapabilities({ hasAllowedRoots: this.allowedRoots.length > 0 }) };
  }

  async submit(input: unknown): Promise<ComputeJobRecord> {
    const spec = computeJobSpecZod.parse(input);
    const existing = this.store.get(spec.jobId);
    if (existing) return this.reconcile(existing);
    const cwd = await realpath(spec.cwd);
    if (!isPathWithinRoots(cwd, this.allowedRoots)) {
      throw new Error("Compute cwd is outside the configured workspace roots.");
    }
    const capability = this.capacity().executors.find((entry) => entry.id === spec.executor);
    if (!capability?.available) {
      throw new Error(capability?.reason ?? `Executor ${spec.executor} is unavailable.`);
    }
    const normalizedSpec: ComputeJobSpec = { ...spec, cwd };
    const jobDir = join(this.rootDir, "jobs", spec.jobId);
    await ensureDir(jobDir);
    const specPath = join(jobDir, "spec.json");
    const statePath = join(jobDir, "state.json");
    const stdoutPath = join(jobDir, "stdout.log");
    const stderrPath = join(jobDir, "stderr.log");
    const submittedAt = new Date().toISOString();
    await writeJsonFileAtomic(specPath, normalizedSpec);
    const initial = computeJobRecordZod.parse({
      id: spec.jobId,
      state: "queued",
      executor: spec.executor,
      command: spec.command,
      cwd,
      resources: spec.resources,
      supervisorPid: null,
      supervisorStartTicks: null,
      childPid: null,
      childStartTicks: null,
      stdoutPath,
      stderrPath,
      exitCode: null,
      failureCode: null,
      failureMessage: null,
      submittedAt,
      startedAt: null,
      completedAt: null,
      lastHeartbeatAt: null,
      peakMemoryKiB: null,
      cpuSeconds: null,
      readBytes: null,
      writeBytes: null
    });
    await writeJsonFileAtomic(statePath, initial);
    this.store.upsert(initial);
    const supervisor = spawn(
      process.execPath,
      [
        this.supervisorPath,
        "--spec",
        specPath,
        "--state",
        statePath,
        "--stdout",
        stdoutPath,
        "--stderr",
        stderrPath,
        "--submitted-at",
        submittedAt
      ],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    supervisor.unref();
    const starting = computeJobRecordZod.parse({
      ...initial,
      state: "starting",
      supervisorPid: supervisor.pid ?? null,
      supervisorStartTicks: supervisor.pid ? await readProcessStartTicks(supervisor.pid) : null,
      lastHeartbeatAt: new Date().toISOString()
    });
    this.store.upsert(starting);
    return starting;
  }

  async get(id: string): Promise<ComputeJobRecord | null> {
    const record = this.store.get(id);
    return record ? this.reconcile(record) : null;
  }

  async logs(id: string, tailBytes: number): Promise<string | null> {
    const record = await this.get(id);
    if (!record) return null;
    const bounded = Math.max(1, Math.min(tailBytes, 2 * 1024 * 1024));
    const readTail = async (path: string | null) => {
      if (!path) return "";
      const content = await readFile(path).catch(() => Buffer.alloc(0));
      return content.subarray(Math.max(0, content.length - bounded)).toString("utf8");
    };
    const [stdout, stderr] = await Promise.all([
      readTail(record.stdoutPath),
      readTail(record.stderrPath)
    ]);
    return `[stdout]\n${stdout}\n[stderr]\n${stderr}`;
  }

  async cancel(id: string): Promise<ComputeJobRecord | null> {
    const record = await this.get(id);
    if (!record || !ACTIVE_STATES.has(record.state)) return record;
    if (
      record.supervisorPid &&
      (await processIdentityMatches(record.supervisorPid, record.supervisorStartTicks))
    ) {
      try {
        process.kill(-record.supervisorPid, "SIGTERM");
      } catch {
        process.kill(record.supervisorPid, "SIGTERM");
      }
      return record;
    }
    const cancelled = computeJobRecordZod.parse({
      ...record,
      state: "cancelled",
      completedAt: new Date().toISOString(),
      failureCode: "CANCELLED_BEFORE_START"
    });
    this.store.upsert(cancelled);
    return cancelled;
  }

  private async reconcileAll(): Promise<void> {
    for (const record of this.store.listActive()) await this.reconcile(record);
  }

  private async reconcile(record: ComputeJobRecord): Promise<ComputeJobRecord> {
    const statePath = join(this.rootDir, "jobs", record.id, "state.json");
    const fromDisk = computeJobRecordZod.safeParse(
      await readJsonFile<unknown>(statePath, record)
    );
    let current = fromDisk.success
      ? computeJobRecordZod.parse({
          ...fromDisk.data,
          state:
            fromDisk.data.state === "queued" && record.state === "starting"
              ? "starting"
              : fromDisk.data.state,
          supervisorPid: fromDisk.data.supervisorPid ?? record.supervisorPid,
          supervisorStartTicks:
            fromDisk.data.supervisorStartTicks ?? record.supervisorStartTicks
        })
      : record;
    if (ACTIVE_STATES.has(current.state)) {
      const alive = await processIdentityMatches(
        current.supervisorPid ?? record.supervisorPid,
        current.supervisorStartTicks ?? record.supervisorStartTicks
      );
      const ageMs = Date.now() - Date.parse(current.submittedAt);
      if (!alive && ageMs > 5_000) {
        current = computeJobRecordZod.parse({
          ...current,
          state: "orphaned",
          completedAt: new Date().toISOString(),
          failureCode: "SUPERVISOR_MISSING",
          failureMessage: "The persisted supervisor PID and start identity are no longer active."
        });
        await writeJsonFileAtomic(statePath, current);
      }
    }
    this.store.upsert(current);
    return current;
  }
}
