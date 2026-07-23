import { spawnSync } from "node:child_process";

export type ComputeExecutorCapability = {
  id: "bubblewrap-local" | "rootless-docker" | "slurm" | "htcondor" | "psij";
  available: boolean;
  hardLimits: boolean;
  reason?: string;
};

function commandWorks(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    timeout: 3_000,
    windowsHide: true
  });
  return result.status === 0;
}

let cachedCapabilities: ComputeExecutorCapability[] | null = null;

export function computeExecutorCapabilities(params: {
  hasAllowedRoots: boolean;
}): ComputeExecutorCapability[] {
  if (cachedCapabilities && params.hasAllowedRoots) return cachedCapabilities;
  const bubblewrap = commandWorks("bwrap", [
    "--unshare-all",
    "--share-net",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--",
    "true"
  ]);
  const dockerClient = commandWorks("docker", ["info", "--format", "{{json .SecurityOptions}}"]);
  const rootlessDocker =
    dockerClient &&
    commandWorks("docker", [
      "run",
      "--rm",
      "--pull=never",
      "--cpus=0.1",
      "--memory=32m",
      "--pids-limit=16",
      process.env.PUPPENCLAW_ROOTLESS_DOCKER_PROBE_IMAGE ?? "alpine:3.20",
      "true"
    ]);
  const capabilities: ComputeExecutorCapability[] = [
    {
      id: "bubblewrap-local",
      available: params.hasAllowedRoots && bubblewrap,
      hardLimits: false,
      reason: !params.hasAllowedRoots
        ? "No compute workspace roots are configured."
        : bubblewrap
          ? "Filesystem and process isolation are available; CPU and memory are metered but not cgroup-hard-limited."
          : "Bubblewrap is not installed or cannot run."
    },
    {
      id: "rootless-docker",
      available: false,
      hardLimits: rootlessDocker,
      reason: rootlessDocker
        ? "The host probe passed, but image selection is not exposed by the current job contract."
        : "A rootless Docker daemon with working cgroup limit flags was not verified."
    },
    { id: "slurm", available: false, hardLimits: true, reason: "Slurm adapter is not configured." },
    { id: "htcondor", available: false, hardLimits: true, reason: "HTCondor adapter is not configured." },
    { id: "psij", available: false, hardLimits: true, reason: "PSI/J adapter is not configured." }
  ];
  if (params.hasAllowedRoots) cachedCapabilities = capabilities;
  return capabilities;
}
