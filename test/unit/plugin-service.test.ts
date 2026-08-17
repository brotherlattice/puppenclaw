import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OrchestratorStore } from "../../src/orchestrator/store.js";
import type { CampaignSpecRecord } from "../../src/orchestrator/types.js";
import {
  configurePuppenclawRegistration,
  createPuppenclawService,
  getPuppenclawOrchestratorStore
} from "../../src/plugin/service.js";
import { createTempDir, resolveFakeAcpxCommand } from "../helpers.js";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

function seedInterruptedCampaign(
  store: OrchestratorStore,
  id: string,
  state: CampaignSpecRecord["state"]
): void {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const runId = `run-${id}`;
  store.upsertCampaign({
    id,
    projectId: "plugin-recovery-project",
    workerId: "local",
    name: id,
    template: "custom",
    experimentCommands: [],
    experimentParallelism: 1,
    iterations: 1,
    steps: [
      {
        id: "step-1",
        title: "Interrupted command",
        kind: "experiment",
        executor: "command",
        command: "long-running-command",
        contextFiles: [],
        approvalRequired: false,
        sessionScope: "campaign",
        env: {},
        retryLimit: 0
      }
    ],
    currentStepIndex: 0,
    currentRunId: runId,
    lastProgressAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    state
  });
  const pid = state === "cancelling" ? 999_999_997 : 999_999_996;
  store.upsertRun({
    id: runId,
    campaignId: id,
    projectId: "plugin-recovery-project",
    workerId: "local",
    stepId: "step-1",
    stepTitle: "Interrupted command",
    stepIndex: 0,
    kind: "experiment",
    executor: "command",
    state: "running",
    startedAt: timestamp,
    updatedAt: timestamp,
    lastProgressAt: timestamp,
    attempts: 1,
    pid,
    processGroupId: pid,
    processStartIdentity: `${pid}:1`
  });
}

describe("Puppenclaw plugin service", () => {
  it("recovers interrupted local campaigns before exposing the runtime", async () => {
    const stateDir = await createTempDir("puppenclaw-plugin-recovery-");
    const pluginDataDir = join(stateDir, "puppenclaw");
    const seedStore = await OrchestratorStore.open(join(pluginDataDir, "orchestrator"));
    seedInterruptedCampaign(seedStore, "plugin-running", "running");
    seedInterruptedCampaign(seedStore, "plugin-cancelling", "cancelling");
    seedStore.close();

    configurePuppenclawRegistration({
      runtime: {},
      logger,
      pluginConfig: {
        backend: "local",
        acpxCommand: await resolveFakeAcpxCommand()
      }
    } as unknown as Parameters<typeof configurePuppenclawRegistration>[0]);
    const service = createPuppenclawService();

    try {
      await service.start({ stateDir, logger } as Parameters<typeof service.start>[0]);
      const recovered = await getPuppenclawOrchestratorStore();
      expect(recovered.getCampaign("plugin-running")?.state).toBe("failed");
      expect(recovered.getRun("run-plugin-running")?.failureCode).toBe(
        "CAMPAIGN_INTERRUPTED"
      );
      expect(recovered.getCampaign("plugin-cancelling")?.state).toBe("cancelled");
      expect(recovered.getRun("run-plugin-cancelling")?.state).toBe("cancelled");
    } finally {
      await service.stop?.();
    }
  });
});
