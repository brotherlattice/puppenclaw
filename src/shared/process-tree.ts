import { spawn, type ChildProcess } from "node:child_process";

/**
 * Describes how a whole process TREE (the spawned child plus any grandchildren)
 * should be terminated on the current platform.
 *
 * - win32: `child.kill()` only signals the direct child (for `shell: true`
 *   spawns that is just the cmd.exe wrapper), orphaning grandchildren which
 *   then become uncancellable. `taskkill /pid <pid> /T /F` kills the tree.
 * - POSIX: killing the negative pid signals the whole process group, which
 *   requires the child to have been spawned with `detached: true`.
 */
export type ProcessTreeKillPlan =
  | {
      method: "taskkill";
      command: string;
      args: string[];
    }
  | {
      method: "process-group";
      target: number;
      signal: NodeJS.Signals;
    }
  | {
      method: "direct";
      signal: NodeJS.Signals;
    };

export function buildProcessTreeKillPlan(
  pid: number | undefined,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform
): ProcessTreeKillPlan {
  if (pid == null) {
    return { method: "direct", signal };
  }
  if (platform === "win32") {
    return {
      method: "taskkill",
      command: "taskkill",
      args: ["/pid", String(pid), "/T", "/F"]
    };
  }
  return { method: "process-group", target: -pid, signal };
}

/**
 * Kills the whole process tree rooted at `child`. Best-effort: falls back to a
 * direct `child.kill(signal)` when the tree kill cannot be issued, and reports
 * failures through `onError` instead of throwing.
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  onError?: (error: Error) => void
): void {
  const plan = buildProcessTreeKillPlan(child.pid, signal);
  try {
    if (plan.method === "taskkill") {
      const killer = spawn(plan.command, plan.args, {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("error", () => {
        fallbackDirectKill(child, signal, onError);
      });
      killer.unref();
      return;
    }
    if (plan.method === "process-group") {
      process.kill(plan.target, plan.signal);
      return;
    }
    child.kill(plan.signal);
  } catch (error) {
    fallbackDirectKill(
      child,
      signal,
      onError,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

/**
 * Kills the tree with `SIGTERM` and escalates to a `SIGKILL` tree kill after
 * `escalationMs` unless the child exits first. The escalation timer is
 * unref'ed so it never keeps the event loop alive.
 */
export function killProcessTreeWithEscalation(
  child: ChildProcess,
  escalationMs: number,
  onError?: (error: Error) => void
): void {
  killProcessTree(child, "SIGTERM", onError);
  const forceKillTimer = setTimeout(() => {
    killProcessTree(child, "SIGKILL", onError);
  }, escalationMs);
  forceKillTimer.unref();
  child.once("exit", () => {
    clearTimeout(forceKillTimer);
  });
}

function fallbackDirectKill(
  child: ChildProcess,
  signal: NodeJS.Signals,
  onError?: (error: Error) => void,
  cause?: Error
): void {
  try {
    child.kill(signal);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    onError?.(cause ?? err);
  }
}
