import { describe, expect, it } from "vitest";

import { computeExecutorCapabilities } from "../../src/compute/capabilities.js";
import { isPathWithinRoots } from "../../src/compute/runtime.js";
import { ComputeStore } from "../../src/compute/store.js";
import { createTempDir } from "../helpers.js";

describe("managed compute runtime", () => {
  it("uses boundary-aware workspace confinement", () => {
    expect(isPathWithinRoots("/share/work/chat/results", ["/share/work/chat"])).toBe(true);
    expect(isPathWithinRoots("/share/work/chat-other", ["/share/work/chat"])).toBe(false);
  });

  it("keeps future executors unavailable until their adapters are configured", () => {
    const capabilities = computeExecutorCapabilities({ hasAllowedRoots: false });
    expect(capabilities.find((entry) => entry.id === "bubblewrap-local")?.available).toBe(false);
    expect(capabilities.find((entry) => entry.id === "rootless-docker")?.available).toBe(false);
    expect(capabilities.find((entry) => entry.id === "slurm")?.available).toBe(false);
  });

  it("persists job identity and state in sqlite", async () => {
    const root = await createTempDir("puppenclaw-compute-store-");
    const store = await ComputeStore.open(root);
    try {
      store.upsert({
        id: "job-1",
        state: "running",
        executor: "bubblewrap-local",
        command: ["true"],
        cwd: root,
        resources: {
          cpuCores: 1,
          memoryMiB: 128,
          wallTimeSeconds: 30,
          gpuCount: 0,
          diskMiB: 0
        },
        supervisorPid: 100,
        supervisorStartTicks: "123",
        childPid: 101,
        childStartTicks: "124",
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
        writeBytes: null
      });
      expect(store.get("job-1")?.supervisorStartTicks).toBe("123");
      expect(store.listActive()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
