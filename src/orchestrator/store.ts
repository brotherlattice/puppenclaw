import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type {
  ArtifactRecord,
  CampaignSpecRecord,
  CampaignProgressSnapshot,
  CampaignStatusSnapshot,
  ProjectRecord,
  RunRecord,
  WorkerRecord
} from "./types.js";
import { ensureDir } from "../shared/utils.js";

type JsonValue = ProjectRecord | WorkerRecord | CampaignSpecRecord | RunRecord | ArtifactRecord;
const NODE_SQLITE_SPECIFIER = `node${":sqlite"}`;

function parseJson<T extends JsonValue>(value: unknown): T {
  if (typeof value !== "string") {
    throw new Error("Invalid sqlite JSON payload");
  }
  return JSON.parse(value) as T;
}

export class OrchestratorStore {
  private constructor(
    private readonly db: DatabaseSyncType,
    readonly rootDir: string
  ) {}

  static async open(rootDir: string): Promise<OrchestratorStore> {
    await ensureDir(rootDir);
    const { DatabaseSync } = await import(NODE_SQLITE_SPECIFIER);
    const db = new DatabaseSync(join(rootDir, "orchestrator.sqlite"));
    const store = new OrchestratorStore(db, rootDir);
    store.migrate();
    return store;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        campaign_id TEXT,
        run_id TEXT,
        payload TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertProject(project: ProjectRecord): void {
    this.db
      .prepare("INSERT INTO projects (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload")
      .run(project.id, JSON.stringify(project));
  }

  getProject(projectId: string): ProjectRecord | null {
    const row = this.db.prepare("SELECT payload FROM projects WHERE id = ?").get(projectId) as
      | { payload: string }
      | undefined;
    return row != null ? parseJson<ProjectRecord>(row.payload) : null;
  }

  listProjects(): ProjectRecord[] {
    return this.db
      .prepare("SELECT payload FROM projects ORDER BY id")
      .all()
      .map((row) => parseJson<ProjectRecord>((row as { payload: string }).payload));
  }

  upsertWorker(worker: WorkerRecord): void {
    this.db
      .prepare("INSERT INTO workers (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload")
      .run(worker.id, JSON.stringify(worker));
  }

  getWorker(workerId: string): WorkerRecord | null {
    const row = this.db.prepare("SELECT payload FROM workers WHERE id = ?").get(workerId) as
      | { payload: string }
      | undefined;
    return row != null ? parseJson<WorkerRecord>(row.payload) : null;
  }

  listWorkers(): WorkerRecord[] {
    return this.db
      .prepare("SELECT payload FROM workers ORDER BY id")
      .all()
      .map((row) => parseJson<WorkerRecord>((row as { payload: string }).payload));
  }

  upsertCampaign(campaign: CampaignSpecRecord): void {
    this.db
      .prepare("INSERT INTO campaigns (id, project_id, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, project_id = excluded.project_id")
      .run(campaign.id, campaign.projectId, JSON.stringify(campaign));
  }

  getCampaign(campaignId: string): CampaignSpecRecord | null {
    const row = this.db.prepare("SELECT payload FROM campaigns WHERE id = ?").get(campaignId) as
      | { payload: string }
      | undefined;
    return row != null ? parseJson<CampaignSpecRecord>(row.payload) : null;
  }

  listCampaigns(projectId?: string): CampaignSpecRecord[] {
    const rows = projectId == null
      ? this.db.prepare("SELECT payload FROM campaigns ORDER BY id").all()
      : this.db.prepare("SELECT payload FROM campaigns WHERE project_id = ? ORDER BY id").all(projectId);
    return rows.map((row) => parseJson<CampaignSpecRecord>((row as { payload: string }).payload));
  }

  upsertRun(run: RunRecord): void {
    this.db
      .prepare("INSERT INTO runs (id, campaign_id, project_id, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, campaign_id = excluded.campaign_id, project_id = excluded.project_id")
      .run(run.id, run.campaignId, run.projectId, JSON.stringify(run));
  }

  listRuns(campaignId: string): RunRecord[] {
    return this.db
      .prepare("SELECT payload FROM runs WHERE campaign_id = ?")
      .all(campaignId)
      .map((row) => parseJson<RunRecord>((row as { payload: string }).payload))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare("SELECT payload FROM runs WHERE id = ?").get(runId) as
      | { payload: string }
      | undefined;
    return row != null ? parseJson<RunRecord>(row.payload) : null;
  }

  upsertArtifact(artifact: ArtifactRecord): void {
    this.db
      .prepare("INSERT INTO artifacts (id, project_id, campaign_id, run_id, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, project_id = excluded.project_id, campaign_id = excluded.campaign_id, run_id = excluded.run_id")
      .run(
        artifact.id,
        artifact.projectId,
        artifact.campaignId ?? null,
        artifact.runId ?? null,
        JSON.stringify(artifact)
      );
  }

  listArtifacts(params: { projectId?: string | undefined; campaignId?: string | undefined } = {}): ArtifactRecord[] {
    let query = "SELECT payload FROM artifacts";
    const values: string[] = [];
    if (params.campaignId != null) {
      query += " WHERE campaign_id = ?";
      values.push(params.campaignId);
    } else if (params.projectId != null) {
      query += " WHERE project_id = ?";
      values.push(params.projectId);
    }
    query += " ORDER BY id";
    return this.db
      .prepare(query)
      .all(...values)
      .map((row) => parseJson<ArtifactRecord>((row as { payload: string }).payload));
  }

  deleteArtifact(artifactId: string): void {
    this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(artifactId);
  }

  getCampaignSnapshot(campaignId: string): CampaignStatusSnapshot | null {
    const campaign = this.getCampaign(campaignId);
    if (campaign == null) {
      return null;
    }
    const runs = this.listRuns(campaign.id);
    const progress = buildCampaignProgress(campaign, runs);
    return {
      campaign,
      project: this.getProject(campaign.projectId),
      worker: this.getWorker(campaign.workerId),
      runs,
      artifacts: this.listArtifacts({ campaignId: campaign.id }),
      progress
    };
  }

  resolveArtifactsDir(): string {
    return join(this.rootDir, "artifacts");
  }

  async captureArtifactSize(relativePath: string): Promise<number> {
    const info = await stat(join(this.resolveArtifactsDir(), relativePath));
    return info.size;
  }
}

function buildCampaignProgress(
  campaign: CampaignSpecRecord,
  runs: RunRecord[]
): CampaignProgressSnapshot {
  const completedSteps = runs.filter((run) => run.state === "completed").length;
  const failedSteps = runs.filter((run) => run.state === "failed").length;
  const currentStep = campaign.steps[campaign.currentStepIndex];
  return {
    totalSteps: campaign.steps.length,
    completedSteps,
    failedSteps,
    currentStepIndex: campaign.currentStepIndex,
    experimentParallelism: campaign.experimentParallelism,
    ...(currentStep != null ? { currentStepId: currentStep.id, currentStepTitle: currentStep.title } : {}),
    ...(campaign.currentRunId != null ? { currentRunId: campaign.currentRunId } : {}),
    lastProgressAt: campaign.lastProgressAt
  };
}
