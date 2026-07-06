import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import type { ISessionManager } from "../../src/manager/interface.js";
import { OrchestratorRuntime } from "../../src/orchestrator/runtime.js";
import { OrchestratorStore } from "../../src/orchestrator/store.js";
import type { CampaignSpecRecord, RunRecord } from "../../src/orchestrator/types.js";
import { OutputRouter } from "../../src/plugin/output-router.js";
import { SessionStore } from "../../src/shared/store.js";
import { textToolResult } from "../../src/shared/tool-results.js";
import type { CampaignRunParams, StartParams, ToolResult } from "../../src/shared/types.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

type StepParams = CampaignRunParams["steps"][number];

type SnapshotDetails = {
  campaign: {
    id: string;
    name: string;
    state: string;
    failureCode?: string;
    lastError?: string;
  };
  runs: Array<{ state: string; failureCode?: string }>;
};

type EventEntry = {
  id: number;
  type: string;
  message: string;
};

async function createRuntime(
  workspaceDir: string,
  configOverrides: Record<string, unknown> = {},
  shared: { store?: OrchestratorStore; sessionManager?: ISessionManager } = {}
): Promise<{ runtime: OrchestratorRuntime; store: OrchestratorStore; sessionStore: SessionStore }> {
  const acpxCommand = await resolveFakeAcpxCommand();
  const config = makeConfig({ acpxCommand, ...configOverrides });
  const sessionStore = await SessionStore.open(workspaceDir);
  const sessionManager =
    shared.sessionManager ??
    new AcpxSessionManager({
      config,
      logger: silentLogger,
      store: sessionStore,
      outputRouter: new OutputRouter(silentLogger)
    });
  const store = shared.store ?? (await OrchestratorStore.open(join(workspaceDir, ".orchestrator")));
  const runtime = new OrchestratorRuntime({
    config,
    logger: silentLogger,
    sessionStore,
    store,
    sessionManager
  });
  return { runtime, store, sessionStore };
}

/**
 * Command steps run with cwd = project root through a real shell
 * (`cmd.exe /d /s /c` on Windows), where nested quotes in `node -e "..."` get
 * mangled by the double quoting layers. Write a real script into the project
 * root and run it by relative path instead — no quoting anywhere.
 */
async function sleepCommand(projectRoot: string, ms: number): Promise<string> {
  const name = `sleep-${ms}.cjs`;
  await writeFile(join(projectRoot, name), `setTimeout(function(){process.exit(0)},${ms});\n`, "utf8");
  return `node ${name}`;
}

async function exitCommand(projectRoot: string, code: number): Promise<string> {
  const name = `exit-${code}.cjs`;
  await writeFile(join(projectRoot, name), `process.exit(${code});\n`, "utf8");
  return `node ${name}`;
}

function commandStep(title: string, command: string, approvalRequired = false): StepParams {
  return {
    title,
    kind: "experiment",
    executor: "command",
    command,
    contextFiles: [],
    approvalRequired,
    env: {},
    retryLimit: 0
  };
}

function baseCampaignParams(projectId: string, name: string): Omit<CampaignRunParams, "steps"> {
  return {
    projectId,
    workerId: "local",
    name,
    template: "custom",
    experimentCommands: [],
    experimentParallelism: 1,
    iterations: 1
  };
}

async function pollUntil<T>(
  probe: () => Promise<T | null>,
  timeoutMs = 20_000,
  intervalMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value != null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
  }
}

async function waitForState(
  runtime: OrchestratorRuntime,
  campaignId: string,
  states: string[]
): Promise<SnapshotDetails> {
  return pollUntil(async () => {
    const result = await runtime.status({ campaignId });
    const details = result.details as SnapshotDetails;
    return states.includes(details.campaign.state) ? details : null;
  });
}

async function listAllEvents(runtime: OrchestratorRuntime, campaignId: string): Promise<EventEntry[]> {
  const result = await runtime.campaignEvents({ campaignId, scope: "all", limit: 200 });
  return (result.details as { events: EventEntry[] }).events;
}

describe("OrchestratorRuntime detached campaigns", () => {
  it("returns immediately from a detached start and completes in the background", async () => {
    const workspaceDir = await createTempDir("puppenclaw-detached-start-");
    const { runtime } = await createRuntime(workspaceDir);
    await runtime.createProject({ name: "detached-project", rootDir: workspaceDir });

    const startedAt = Date.now();
    const started = await runtime.runCampaign({
      ...baseCampaignParams("detached-project", "detached-run"),
      detached: true,
      steps: [commandStep("Sleep step", await sleepCommand(workspaceDir, 3_000))]
    });
    const elapsedMs = Date.now() - startedAt;
    const startedDetails = started.details as SnapshotDetails;
    expect(startedDetails.campaign.state).toBe("running");
    expect(started.content[0]?.text).toContain("mode: detached");
    // The step sleeps ~3s; a detached start must not wait for it.
    expect(elapsedMs).toBeLessThan(1_500);

    const finished = await waitForState(runtime, startedDetails.campaign.id, [
      "completed",
      "failed",
      "cancelled"
    ]);
    expect(finished.campaign.state, finished.campaign.lastError).toBe("completed");
  }, 30_000);

  it("records ordered lifecycle events with integer cursors under scope all", async () => {
    const workspaceDir = await createTempDir("puppenclaw-detached-events-");
    const { runtime } = await createRuntime(workspaceDir);
    await runtime.createProject({ name: "events-project", rootDir: workspaceDir });

    const campaign = await runtime.runCampaign({
      ...baseCampaignParams("events-project", "events-run"),
      steps: [
        commandStep("Step one", await sleepCommand(workspaceDir, 10)),
        commandStep("Step two", await sleepCommand(workspaceDir, 10))
      ]
    });
    const campaignId = (campaign.details as SnapshotDetails).campaign.id;
    expect((campaign.details as SnapshotDetails).campaign.state).toBe("completed");

    const all = await runtime.campaignEvents({ campaignId, scope: "all", limit: 100 });
    const allDetails = all.details as { scope?: string; cursor?: string; events: EventEntry[] };
    expect(allDetails.scope).toBe("all");
    expect(allDetails.events.map((event) => event.type)).toEqual([
      "campaign_created",
      "step_started",
      "step_completed",
      "step_started",
      "step_completed",
      "campaign_completed"
    ]);
    for (const event of allDetails.events) {
      expect(Number.isInteger(event.id)).toBe(true);
    }
    for (let index = 1; index < allDetails.events.length; index += 1) {
      expect(allDetails.events[index]!.id).toBeGreaterThan(allDetails.events[index - 1]!.id);
    }
    expect(allDetails.cursor).toBe(String(allDetails.events.at(-1)!.id));

    const paged = await runtime.campaignEvents({
      campaignId,
      scope: "all",
      after: String(allDetails.events[1]!.id),
      limit: 100
    });
    const pagedDetails = paged.details as { events: EventEntry[] };
    expect(pagedDetails.events.map((event) => event.id)).toEqual(
      allDetails.events.slice(2).map((event) => event.id)
    );

    // Default (omitted) scope keeps the legacy fusion-only behavior: a
    // non-fusion campaign has no fusion events.
    const legacy = await runtime.campaignEvents({ campaignId, limit: 100 });
    expect((legacy.details as { events: unknown[] }).events).toEqual([]);
  });

  it("runs the detached approve flow with recorded approval events", async () => {
    const workspaceDir = await createTempDir("puppenclaw-detached-approve-");
    const { runtime } = await createRuntime(workspaceDir);
    await runtime.createProject({ name: "approve-project", rootDir: workspaceDir });

    const started = await runtime.runCampaign({
      ...baseCampaignParams("approve-project", "approve-run"),
      detached: true,
      steps: [
        commandStep("Fast step", await sleepCommand(workspaceDir, 10)),
        commandStep("Gated step", await sleepCommand(workspaceDir, 2_500), true)
      ]
    });
    const campaignId = (started.details as SnapshotDetails).campaign.id;

    await waitForState(runtime, campaignId, ["waiting_approval"]);
    const waitingEvents = await listAllEvents(runtime, campaignId);
    expect(waitingEvents.some((event) => event.type === "waiting_approval")).toBe(true);

    const approveStartedAt = Date.now();
    const approved = await runtime.approve({ campaignId, detached: true });
    const approveElapsedMs = Date.now() - approveStartedAt;
    expect(approved.content[0]?.text).toContain("mode: detached");
    expect((approved.details as SnapshotDetails).campaign.state).toBe("running");
    // The gated step sleeps ~2.5s; a detached approve must not wait for it.
    expect(approveElapsedMs).toBeLessThan(2_000);
    const approvedEvents = await listAllEvents(runtime, campaignId);
    expect(approvedEvents.some((event) => event.type === "approved")).toBe(true);

    const finished = await waitForState(runtime, campaignId, ["completed", "failed", "cancelled"]);
    expect(finished.campaign.state, finished.campaign.lastError).toBe("completed");

    await expect(runtime.approve({ campaignId })).rejects.toMatchObject({
      code: "CAMPAIGN_NOT_WAITING_APPROVAL"
    });
  }, 30_000);

  it("ends a cancelled detached campaign as cancelled, never failed", async () => {
    const workspaceDir = await createTempDir("puppenclaw-detached-cancel-");
    const { runtime } = await createRuntime(workspaceDir);
    await runtime.createProject({ name: "cancel-project", rootDir: workspaceDir });

    const started = await runtime.runCampaign({
      ...baseCampaignParams("cancel-project", "cancel-run"),
      detached: true,
      steps: [commandStep("Slow step", await sleepCommand(workspaceDir, 8_000))]
    });
    const campaignId = (started.details as SnapshotDetails).campaign.id;

    await pollUntil(async () => {
      const events = await listAllEvents(runtime, campaignId);
      return events.some((event) => event.type === "step_started") ? events : null;
    });
    await runtime.cancel({ campaignId });

    // The killed run settles shortly after cancel; wait for it so the
    // no-campaign_failed assertion below observes the final event stream.
    await pollUntil(async () => {
      const result = await runtime.status({ campaignId });
      const details = result.details as SnapshotDetails;
      const settled = details.runs.every((run) =>
        ["completed", "failed", "cancelled"].includes(run.state)
      );
      return settled ? details : null;
    });

    const snapshot = await runtime.status({ campaignId });
    expect((snapshot.details as SnapshotDetails).campaign.state).toBe("cancelled");
    const events = await listAllEvents(runtime, campaignId);
    expect(events.some((event) => event.type === "campaign_cancelled")).toBe(true);
    expect(events.some((event) => event.type === "campaign_failed")).toBe(false);
  }, 30_000);

  it("marks a failing detached campaign failed with step and campaign failure events", async () => {
    const workspaceDir = await createTempDir("puppenclaw-detached-fail-");
    const { runtime } = await createRuntime(workspaceDir);
    await runtime.createProject({ name: "fail-project", rootDir: workspaceDir });

    const started = await runtime.runCampaign({
      ...baseCampaignParams("fail-project", "fail-run"),
      detached: true,
      steps: [commandStep("Failing step", await exitCommand(workspaceDir, 3))]
    });
    const campaignId = (started.details as SnapshotDetails).campaign.id;

    const finished = await waitForState(runtime, campaignId, ["completed", "failed", "cancelled"]);
    expect(finished.campaign.state).toBe("failed");
    expect(finished.runs.some((run) => run.state === "failed")).toBe(true);
    const events = await listAllEvents(runtime, campaignId);
    expect(events.some((event) => event.type === "step_failed")).toBe(true);
    expect(events.some((event) => event.type === "campaign_failed")).toBe(true);
  }, 30_000);

  it("recovers interrupted campaigns exactly once and leaves parked campaigns alone", async () => {
    const workspaceDir = await createTempDir("puppenclaw-detached-recover-");
    const store = await OrchestratorStore.open(join(workspaceDir, ".orchestrator"));
    const now = "2026-01-01T00:00:00.000Z";
    const makeStoredCampaign = (id: string, state: CampaignSpecRecord["state"]): CampaignSpecRecord => ({
      id,
      projectId: "recover-project",
      workerId: "local",
      name: `campaign-${id}`,
      template: "custom",
      experimentCommands: [],
      experimentParallelism: 1,
      iterations: 1,
      steps: [],
      currentStepIndex: 0,
      lastProgressAt: now,
      createdAt: now,
      updatedAt: now,
      state,
      ...(state === "waiting_approval" ? { waitingApprovalStepId: "step-1" } : {})
    });
    store.upsertCampaign(makeStoredCampaign("camp-interrupted", "running"));
    const interruptedRun: RunRecord = {
      id: "run-interrupted",
      campaignId: "camp-interrupted",
      projectId: "recover-project",
      workerId: "local",
      stepId: "step-1",
      stepTitle: "Interrupted step",
      stepIndex: 0,
      kind: "experiment",
      executor: "command",
      state: "running",
      startedAt: now,
      updatedAt: now,
      lastProgressAt: now,
      attempts: 1
    };
    store.upsertRun(interruptedRun);
    store.upsertCampaign(makeStoredCampaign("camp-parked", "waiting_approval"));

    const { runtime } = await createRuntime(workspaceDir, {}, { store });
    await runtime.recoverInterruptedCampaigns();

    const recovered = store.getCampaign("camp-interrupted");
    expect(recovered?.state).toBe("failed");
    expect(recovered?.failureCode).toBe("CAMPAIGN_INTERRUPTED");
    const recoveredRun = store.listRuns("camp-interrupted")[0];
    expect(recoveredRun?.state).toBe("failed");
    expect(recoveredRun?.failureCode).toBe("CAMPAIGN_INTERRUPTED");
    const events = store.listCampaignEvents({ campaignId: "camp-interrupted", limit: 50 });
    expect(events.map((event) => event.type)).toEqual(["campaign_interrupted"]);

    const parked = store.getCampaign("camp-parked");
    expect(parked?.state).toBe("waiting_approval");
    expect(store.listCampaignEvents({ campaignId: "camp-parked", limit: 50 })).toEqual([]);

    // Idempotent: neither a repeat call nor a fresh runtime over the already
    // reconciled store appends further events.
    await runtime.recoverInterruptedCampaigns();
    const second = await createRuntime(workspaceDir, {}, { store });
    await second.runtime.recoverInterruptedCampaigns();
    expect(store.listCampaignEvents({ campaignId: "camp-interrupted", limit: 50 })).toHaveLength(1);
  });

  it("enforces only-running capacity and reconciles configured worker capacity", async () => {
    const workspaceDir = await createTempDir("puppenclaw-detached-capacity-");
    const { runtime, store } = await createRuntime(workspaceDir);
    await runtime.createProject({ name: "capacity-project", rootDir: workspaceDir });

    const parked = await runtime.runCampaign({
      ...baseCampaignParams("capacity-project", "parked-run"),
      steps: [commandStep("Gated step", await sleepCommand(workspaceDir, 10), true)]
    });
    const parkedId = (parked.details as SnapshotDetails).campaign.id;
    expect((parked.details as SnapshotDetails).campaign.state).toBe("waiting_approval");

    // A parked waiting_approval campaign does not consume the only slot.
    const second = await runtime.runCampaign({
      ...baseCampaignParams("capacity-project", "second-run"),
      steps: [commandStep("Fast step", await sleepCommand(workspaceDir, 10))]
    });
    expect((second.details as SnapshotDetails).campaign.state).toBe("completed");

    // A running detached campaign does: approving the parked one is rejected
    // before any state mutates.
    const slow = await runtime.runCampaign({
      ...baseCampaignParams("capacity-project", "slow-run"),
      detached: true,
      steps: [commandStep("Slow step", await sleepCommand(workspaceDir, 8_000))]
    });
    const slowId = (slow.details as SnapshotDetails).campaign.id;
    expect((slow.details as SnapshotDetails).campaign.state).toBe("running");
    await expect(runtime.approve({ campaignId: parkedId })).rejects.toMatchObject({
      code: "WORKER_CAPACITY_REACHED"
    });
    const stillParked = await runtime.status({ campaignId: parkedId });
    expect((stillParked.details as SnapshotDetails).campaign.state).toBe("waiting_approval");

    await runtime.cancel({ campaignId: slowId });
    const approved = await runtime.approve({ campaignId: parkedId });
    expect((approved.details as SnapshotDetails).campaign.state).toBe("completed");

    // ensureDefaultWorker keeps plugin config authoritative for capacity.
    expect(store.getWorker("local")?.maxConcurrentRuns).toBe(1);
    const bumped = await createRuntime(
      workspaceDir,
      { orchestration: { localWorker: { maxConcurrentRuns: 4 } } },
      { store }
    );
    await bumped.runtime.status({});
    expect(store.getWorker("local")?.maxConcurrentRuns).toBe(4);
  }, 40_000);

  it("passes campaign model provider settings through to ACP session start", async () => {
    const workspaceDir = await createTempDir("puppenclaw-detached-provider-");
    const startCalls: StartParams[] = [];
    const stubResult = (): ToolResult => textToolResult("stub", { output: "stub-output" });
    const recordingManager: ISessionManager = {
      async start(params) {
        startCalls.push(params);
        return stubResult();
      },
      async send() {
        return stubResult();
      },
      async stop() {
        return stubResult();
      },
      async resume() {
        return stubResult();
      },
      async suspend() {
        return stubResult();
      },
      async focus() {
        return stubResult();
      },
      async unfocus() {
        return stubResult();
      },
      async fork() {
        return stubResult();
      },
      async status() {
        return stubResult();
      },
      async output() {
        return stubResult();
      },
      async cost() {
        return stubResult();
      },
      async purge() {
        return stubResult();
      },
      async gc() {}
    };
    const { runtime } = await createRuntime(workspaceDir, {}, { sessionManager: recordingManager });
    await runtime.createProject({ name: "provider-project", rootDir: workspaceDir });

    const provider = {
      id: "prov-openai-compat",
      model: "compat-model-1",
      baseUrl: "http://127.0.0.1:9999/v1"
    };
    const campaign = await runtime.runCampaign({
      ...baseCampaignParams("provider-project", "provider-run"),
      modelProviderId: "prov-openai-compat",
      modelProvider: provider,
      steps: [
        {
          title: "ACP step",
          kind: "code",
          executor: "acp",
          instruction: "Do the work.",
          contextFiles: [],
          approvalRequired: false,
          env: {},
          retryLimit: 0
        }
      ]
    });
    const details = campaign.details as SnapshotDetails;
    expect(details.campaign.state, details.campaign.lastError).toBe("completed");
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.modelProviderId).toBe("prov-openai-compat");
    expect(startCalls[0]?.modelProvider).toEqual(provider);
  });
});
