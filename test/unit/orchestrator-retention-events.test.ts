import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { OrchestratorRuntime } from "../../src/orchestrator/runtime.js";
import { OrchestratorStore } from "../../src/orchestrator/store.js";
import type {
  ArtifactRecord,
  CampaignSpecRecord,
  FusionWorktreeRecord
} from "../../src/orchestrator/types.js";
import { OutputRouter } from "../../src/plugin/output-router.js";
import { SessionStore } from "../../src/shared/store.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

async function createRuntime(workspaceDir: string): Promise<{
  runtime: OrchestratorRuntime;
  store: OrchestratorStore;
}> {
  const acpxCommand = await resolveFakeAcpxCommand();
  const sessionStore = await SessionStore.open(workspaceDir);
  const manager = new AcpxSessionManager({
    config: makeConfig({ acpxCommand }),
    logger: silentLogger,
    store: sessionStore,
    outputRouter: new OutputRouter(silentLogger)
  });
  const store = await OrchestratorStore.open(join(workspaceDir, ".orchestrator"));
  const runtime = new OrchestratorRuntime({
    config: makeConfig({ acpxCommand }),
    logger: silentLogger,
    sessionStore,
    store,
    sessionManager: manager
  });
  return { runtime, store };
}

function makeWorktree(agent: string, workspaceDir: string): FusionWorktreeRecord {
  return {
    agent: agent as FusionWorktreeRecord["agent"],
    path: join(workspaceDir, `worktree-${agent}`),
    branch: `fusion-${agent}`,
    baseRef: "HEAD",
    baseCommit: "abc1234"
  };
}

function makeCampaign(params: {
  id: string;
  workspaceDir: string;
  state: CampaignSpecRecord["state"];
  withFusionEvents?: boolean;
}): CampaignSpecRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: params.id,
    projectId: "demo-project",
    workerId: "local",
    name: `campaign-${params.id}`,
    template: "puppenfusion",
    experimentCommands: [],
    experimentParallelism: 1,
    iterations: 1,
    steps: [],
    currentStepIndex: 0,
    lastProgressAt: now,
    createdAt: now,
    updatedAt: now,
    state: params.state,
    ...(params.withFusionEvents === true
      ? {
          fusion: {
            baseRef: "HEAD",
            baseCommit: "abc1234",
            preferredAgent: "codex",
            useExternalArbiter: false,
            bundleArtifactId: "art-bundle",
            bundleHash: "bundle-hash",
            currentPhase: "plan",
            approvalState: "waiting",
            integrationState: "pending",
            resolverUsed: false,
            worktrees: {
              codex: makeWorktree("codex", params.workspaceDir),
              claude: makeWorktree("claude", params.workspaceDir),
              merged: makeWorktree("merged", params.workspaceDir)
            },
            candidateStates: {},
            events: [
              {
                type: "fusion_plan_ready",
                createdAt: "2026-01-01T00:00:00.000Z",
                message: "first",
                phase: "plan"
              },
              {
                type: "fusion_waiting_approval",
                createdAt: "2026-01-01T00:00:01.000Z",
                message: "second",
                phase: "plan"
              },
              {
                type: "fusion_approved",
                createdAt: "2026-01-01T00:00:01.000Z",
                message: "third",
                phase: "plan"
              }
            ],
            phaseSummaries: []
          }
        }
      : {})
  };
}

function makeArtifact(params: {
  id: string;
  campaignId: string;
  relativePath: string;
  createdAt: string;
}): ArtifactRecord {
  return {
    id: params.id,
    projectId: "demo-project",
    campaignId: params.campaignId,
    siteId: "local",
    kind: "fusion-bundle",
    title: `artifact ${params.id}`,
    relativePath: params.relativePath,
    createdAt: params.createdAt,
    sizeBytes: 4,
    sha256: "deadbeef"
  };
}

describe("OrchestratorRuntime campaign events paging", () => {
  it("delivers every event exactly once across pages with equal timestamps", async () => {
    const workspaceDir = await createTempDir("puppenclaw-events-");
    const { runtime, store } = await createRuntime(workspaceDir);
    store.upsertCampaign(
      makeCampaign({
        id: "camp-events",
        workspaceDir,
        state: "waiting_approval",
        withFusionEvents: true
      })
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const result = await runtime.campaignEvents({
        campaignId: "camp-events",
        ...(cursor != null ? { after: cursor } : {}),
        limit: 1
      });
      const details = result.details as {
        events: Array<{ message: string }>;
        cursor?: string;
      };
      if (details.events.length === 0) {
        expect(details.cursor).toBeUndefined();
        break;
      }
      seen.push(...details.events.map((event) => event.message));
      expect(details.cursor).toBeTruthy();
      cursor = details.cursor;
    }

    expect(seen).toEqual(["first", "second", "third"]);
  });

  it("keeps legacy bare-timestamp cursors working with strictly-greater semantics", async () => {
    const workspaceDir = await createTempDir("puppenclaw-events-legacy-");
    const { runtime, store } = await createRuntime(workspaceDir);
    store.upsertCampaign(
      makeCampaign({
        id: "camp-legacy",
        workspaceDir,
        state: "waiting_approval",
        withFusionEvents: true
      })
    );

    const result = await runtime.campaignEvents({
      campaignId: "camp-legacy",
      after: "2026-01-01T00:00:00.000Z",
      limit: 100
    });
    const details = result.details as {
      events: Array<{ message: string }>;
    };
    expect(details.events.map((event) => event.message)).toEqual(["second", "third"]);
  });
});

describe("OrchestratorRuntime artifact retention", () => {
  it("never prunes artifacts of running or waiting_approval campaigns", async () => {
    const workspaceDir = await createTempDir("puppenclaw-prune-");
    const { runtime, store } = await createRuntime(workspaceDir);

    store.upsertCampaign(
      makeCampaign({ id: "camp-waiting", workspaceDir, state: "waiting_approval" })
    );
    store.upsertCampaign(
      makeCampaign({ id: "camp-running", workspaceDir, state: "running" })
    );
    store.upsertCampaign(
      makeCampaign({ id: "camp-done", workspaceDir, state: "completed" })
    );

    const expiredCreatedAt = "2000-01-01T00:00:00.000Z";
    const artifacts = [
      makeArtifact({
        id: "art-waiting",
        campaignId: "camp-waiting",
        relativePath: "demo-project/camp-waiting/bundle.json",
        createdAt: expiredCreatedAt
      }),
      makeArtifact({
        id: "art-running",
        campaignId: "camp-running",
        relativePath: "demo-project/camp-running/bundle.json",
        createdAt: expiredCreatedAt
      }),
      makeArtifact({
        id: "art-done",
        campaignId: "camp-done",
        relativePath: "demo-project/camp-done/bundle.json",
        createdAt: expiredCreatedAt
      })
    ];
    for (const artifact of artifacts) {
      const filePath = join(store.resolveArtifactsDir(), artifact.relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, "data", "utf8");
      store.upsertArtifact(artifact);
    }

    // Any orchestrator entry point triggers prepareRuntime -> pruneArtifacts.
    await runtime.listArtifacts({});

    expect(store.getArtifact("art-waiting")).not.toBeNull();
    expect(store.getArtifact("art-running")).not.toBeNull();
    expect(store.getArtifact("art-done")).toBeNull();
  });
});
