import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/core";

import type { ISessionManager } from "../manager/interface.js";
import { PuppenclawError } from "../shared/errors.js";
import { DEFAULT_ACPX_AGENT_COMMANDS } from "../shared/schema.js";
import type { SessionStore } from "../shared/store.js";
import { jsonToolResult, textToolResult } from "../shared/tool-results.js";
import type {
  AgentKind,
  ArtifactListParams,
  CampaignActionParams,
  CampaignRunParams,
  CampaignStatusParams,
  ContextSyncParams,
  EffortLevel,
  LogsParams,
  LogsResult,
  PermissionMode,
  ParsedPluginConfig,
  PlanningProfile,
  ProjectCreateParams,
  SiteAgentAvailability,
  SiteStatus,
  SiteStatusParams,
  ToolResult,
  WorkerManifestInput
} from "../shared/types.js";
import { ensureDir, loadContextFiles, nowIso, pathExists } from "../shared/utils.js";
import { OrchestratorStore } from "./store.js";
import type {
  ArtifactRecord,
  FusionCandidate,
  FusionCampaignRecord,
  FusionStepConfig,
  FusionWorktreeRecord,
  CampaignSpecRecord,
  CampaignStatusSnapshot,
  CampaignStepRecord,
  IOrchestrator,
  ProjectContextBundle,
  ProjectRecord,
  RunRecord,
  WorkerRecord
} from "./types.js";

type PendingArtifact = {
  kind: ArtifactRecord["kind"];
  title: string;
  summary?: string;
  relativePath: string;
  content: string;
};

type StepExecutionResult = {
  summary: string;
  outputText: string;
  artifactKind: ArtifactRecord["kind"];
  artifactTitle: string;
  exitCode?: number;
  sessionName?: string;
  nextCampaignSessionName?: string;
  command?: string;
  extraArtifacts?: PendingArtifact[];
};

type ShellCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputText: string;
};

type StepAttemptOutcome =
  | {
      ok: true;
      result: StepExecutionResult;
      attempts: number;
    }
  | {
      ok: false;
      message: string;
      outputText: string;
      attempts: number;
      failureCode?: string;
      failureCategory: RunRecord["failureCategory"];
    };

type StepRunOutcome =
  | {
      ok: true;
      run: RunRecord;
      artifact: ArtifactRecord;
    }
  | {
      ok: false;
      run: RunRecord;
    };

type StepInput = {
  id?: string | undefined;
  title: string;
  kind: CampaignStepRecord["kind"];
  executor: CampaignStepRecord["executor"];
  instruction?: string | undefined;
  command?: string | undefined;
  contextFiles?: string[] | undefined;
  approvalRequired?: boolean | undefined;
  agent?: CampaignStepRecord["agent"] | undefined;
  phaseGroup?: string | undefined;
  sessionScope?: "campaign" | "step" | undefined;
  workingDirectory?: string | undefined;
  env?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  retryLimit?: number | undefined;
  fusion?: FusionStepConfig | undefined;
};

type FusionBundle = {
  campaignId: string;
  projectId: string;
  projectName: string;
  rootDir: string;
  createdAt: string;
  baseRef: string;
  baseCommit: string;
  task: string;
  evaluationCommand?: string;
  contextBundleArtifactId?: string;
  contextPromptText?: string;
  preferredAgent: FusionCandidate;
  decisionPolicy: string;
};

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "item";
}

function summarizeText(value: string, max = 220): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function normalizeArtifactContent(content: string): string {
  return `${content.trimEnd()}\n`;
}

function hashTextContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function shortHash(value: string, length = 12): string {
  return value.slice(0, length);
}

function trimLogText(value: string, limitChars: number): string {
  if (value.length <= limitChars) {
    return value;
  }
  return `[truncated]\n${value.slice(-limitChars)}`;
}

function transcriptToLogText(
  transcript: Array<{ role: string; text: string; createdAt: string }>
): string {
  return transcript
    .map((entry) => `[${entry.createdAt}] ${entry.role}: ${entry.text}`)
    .join("\n\n")
    .trim();
}

const FUSION_CANDIDATES: FusionCandidate[] = ["codex", "claude"];

function relativeArtifactPath(params: {
  projectId: string;
  campaignId?: string;
  runId?: string;
  extension: string;
  title: string;
}): string {
  const parts = [params.projectId];
  if (params.campaignId != null) {
    parts.push(params.campaignId);
  }
  const fileBase = `${params.runId ?? nowIso().replace(/[:.]/gu, "-")}-${slug(params.title)}.${params.extension}`;
  parts.push(fileBase);
  return parts.join("/");
}

function describeCampaign(snapshot: CampaignStatusSnapshot): string {
  return [
    `Campaign ${snapshot.campaign.name} (${snapshot.campaign.id})`,
    `state: ${snapshot.campaign.state}`,
    `project: ${snapshot.project?.name ?? snapshot.campaign.projectId}`,
    `worker: ${snapshot.worker?.label ?? snapshot.campaign.workerId}`,
    `runs: ${snapshot.runs.length}`,
    `artifacts: ${snapshot.artifacts.length}`
  ].join("\n");
}

export class OrchestratorRuntime implements IOrchestrator {
  private readonly activeCommands = new Map<string, Set<ChildProcessWithoutNullStreams>>();

  constructor(
    private readonly deps: {
      config: ParsedPluginConfig;
      store: OrchestratorStore;
      sessionStore: SessionStore;
      sessionManager: ISessionManager;
      logger: PluginLogger;
    }
  ) {}

  async ensureDefaultWorker(): Promise<void> {
    if (!this.deps.config.orchestration.enabled) {
      return;
    }
    const configured = this.deps.config.orchestration.localWorker;
    const existing = this.deps.store.getWorker(configured.id);
    if (existing != null) {
      return;
    }
    const now = nowIso();
    this.deps.store.upsertWorker({
      ...configured,
      supportedSteps: [
        "judge",
        "research",
        "plan",
        "code",
        "experiment",
        "eval",
        "review",
        "publish",
        "handoff"
      ],
      executors: this.deps.config.orchestration.allowLocalCommandExecution ? ["acp", "command"] : ["acp"],
      maxConcurrentRuns: 1,
      adminOnlyRawSessions: true,
      createdAt: now,
      updatedAt: now,
      defaultAgent: this.deps.config.defaultAgent
    });
  }

  private async prepareRuntime(): Promise<void> {
    await this.ensureDefaultWorker();
    await this.pruneArtifacts();
  }

  async createProject(params: ProjectCreateParams): Promise<ToolResult> {
    await this.prepareRuntime();
    const rootDir = resolve(
      this.deps.config.orchestration.defaultProjectRoot ?? process.cwd(),
      params.rootDir
    );
    if (!(await pathExists(rootDir))) {
      throw new PuppenclawError("PROJECT_ROOT_MISSING", `Project root does not exist: ${rootDir}`);
    }
    const now = nowIso();
    const id = params.id ?? slug(params.name);
    const project: ProjectRecord = {
      id,
      name: params.name,
      rootDir,
      ...(params.description != null ? { description: params.description } : {}),
      ...(params.defaultAgent != null ? { defaultAgent: params.defaultAgent } : {}),
      ...(params.fusionPreferredAgent != null
        ? { fusionPreferredAgent: params.fusionPreferredAgent }
        : {}),
      ...(params.planningProfile != null ? { planningProfile: params.planningProfile } : {}),
      ...(params.permissionMode != null ? { permissionMode: params.permissionMode } : {}),
      ...(params.effort != null ? { effort: params.effort } : {}),
      ...(params.model != null ? { model: params.model } : {}),
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.upsertProject(project);
    return textToolResult(`Created project ${project.name} (${project.id}) at ${project.rootDir}.`, {
      project
    });
  }

  async registerWorker(params: WorkerManifestInput): Promise<ToolResult> {
    await this.prepareRuntime();
    const now = nowIso();
    const worker: WorkerRecord = {
      ...params,
      labels: [...params.labels],
      projectRoots: params.projectRoots.map((entry) => resolve(entry)),
      supportedSteps: [...params.supportedSteps],
      executors: [...params.executors],
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.upsertWorker(worker);
    return textToolResult(`Registered worker ${worker.label} (${worker.id}).`, { worker });
  }

  async syncContext(params: ContextSyncParams): Promise<ToolResult> {
    await this.prepareRuntime();
    const project = this.requireProject(params.projectId);
    const loaded = await loadContextFiles(project.rootDir, params.includeFiles, {
      maxFiles: 16,
      maxBytesPerFile: 48 * 1024
    });
    const bundle: ProjectContextBundle = {
      projectId: project.id,
      projectName: project.name,
      rootDir: project.rootDir,
      createdAt: nowIso(),
      includeFiles: loaded.files,
      ...(params.notes != null && params.notes.trim().length > 0 ? { notes: params.notes.trim() } : {}),
      ...(params.memoryText != null && params.memoryText.trim().length > 0
        ? { memoryText: params.memoryText.trim() }
        : {}),
      promptText: loaded.promptText
    };
    const relativePath = relativeArtifactPath({
      projectId: project.id,
      extension: "json",
      title: "context-bundle"
    });
    const artifact = await this.writeTextArtifact({
      projectId: project.id,
      kind: "context",
      title: "Context Bundle",
      summary: `Context bundle with ${loaded.files.length} file(s) for ${project.name}.`,
      relativePath,
      content: JSON.stringify(bundle, null, 2)
    });
    this.deps.store.upsertProject({
      ...project,
      lastContextSyncAt: bundle.createdAt,
      updatedAt: bundle.createdAt
    });
    return textToolResult(
      `Synchronized context for ${project.name} with ${loaded.files.length} file(s).`,
      { project, artifact, bundle }
    );
  }

  async runCampaign(params: CampaignRunParams): Promise<ToolResult> {
    await this.prepareRuntime();
    if (!this.deps.config.orchestration.enabled) {
      throw new PuppenclawError("ORCHESTRATION_DISABLED", "Orchestration is disabled in plugin config.");
    }
    const project = this.requireProject(params.projectId);
    const worker = this.requireWorker(params.workerId);
    const experimentParallelism = params.experimentParallelism ?? 1;
    const iterations = params.iterations ?? 1;
    this.ensureCampaignCapacity();
    const now = nowIso();
    const campaignId = `camp-${randomUUID()}`;
    const preparedFusion = params.template === "puppenfusion"
      ? await this.prepareFusionCampaign(project, params, campaignId)
      : null;
    const steps = preparedFusion?.steps ?? this.buildSteps({
      ...params,
      experimentParallelism,
      iterations
    });
    this.ensureWorkerSupports(worker, project, steps);
    const campaign: CampaignSpecRecord = {
      id: campaignId,
      projectId: project.id,
      workerId: worker.id,
      name: params.name,
      template: params.template,
      ...(params.task != null ? { task: params.task } : {}),
      ...(params.evaluationCommand != null ? { evaluationCommand: params.evaluationCommand } : {}),
      experimentCommands: [...params.experimentCommands],
      experimentParallelism,
      iterations,
      steps,
      currentStepIndex: 0,
      lastProgressAt: now,
      createdAt: now,
      updatedAt: now,
      state: "running",
      ...(preparedFusion != null ? { fusion: preparedFusion.fusion } : {})
    };
    this.deps.store.upsertCampaign(campaign);
    const snapshot = await this.executeCampaign(campaign);
    return textToolResult(describeCampaign(snapshot), snapshot);
  }

  async status(params: CampaignStatusParams = {}): Promise<ToolResult> {
    await this.prepareRuntime();
    if (params.campaignId != null) {
      const snapshot = this.deps.store.getCampaignSnapshot(params.campaignId);
      if (snapshot == null) {
        throw new PuppenclawError("UNKNOWN_CAMPAIGN", `Unknown campaign ${params.campaignId}.`);
      }
      return textToolResult(describeCampaign(snapshot), snapshot);
    }
    const payload = {
      projects: this.deps.store.listProjects(),
      workers: this.deps.store.listWorkers(),
      campaigns: this.deps.store.listCampaigns(params.projectId)
    };
    return jsonToolResult(payload, "Puppenclaw orchestration status");
  }

  async listArtifacts(params: ArtifactListParams = {}): Promise<ToolResult> {
    await this.prepareRuntime();
    const artifacts = this.deps.store.listArtifacts({
      ...(params.projectId != null ? { projectId: params.projectId } : {}),
      ...(params.campaignId != null ? { campaignId: params.campaignId } : {})
    });
    return jsonToolResult({ artifacts }, "Puppenclaw artifacts");
  }

  async approve(params: CampaignActionParams): Promise<ToolResult> {
    await this.prepareRuntime();
    const campaign = this.requireCampaign(params.campaignId);
    if (campaign.waitingApprovalStepId == null) {
      throw new PuppenclawError(
        "CAMPAIGN_NOT_WAITING_APPROVAL",
        `Campaign ${campaign.id} is not waiting for approval.`
      );
    }
    const approvedStepId = campaign.waitingApprovalStepId;
    const resumedAt = nowIso();
    const resumed: CampaignSpecRecord = {
      ...campaign,
      state: "running",
      lastProgressAt: resumedAt,
      updatedAt: resumedAt
    };
    delete resumed.waitingApprovalStepId;
    this.deps.store.upsertCampaign(resumed);
    const snapshot = await this.executeCampaign(resumed, approvedStepId);
    return textToolResult(`Approved campaign ${snapshot.campaign.name}.`, snapshot);
  }

  async cancel(params: CampaignActionParams): Promise<ToolResult> {
    await this.prepareRuntime();
    const campaign = this.requireCampaign(params.campaignId);
    const active = this.activeCommands.get(campaign.id);
    if (active != null) {
      for (const child of active) {
        child.kill("SIGTERM");
      }
      this.activeCommands.delete(campaign.id);
    }
    if (campaign.acpSessionName != null) {
      try {
        await this.deps.sessionManager.stop({ name: campaign.acpSessionName });
      } catch (error) {
        this.deps.logger.warn(
          `Failed to stop ACP session ${campaign.acpSessionName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const cancelled: CampaignSpecRecord = {
      ...campaign,
      state: "cancelled",
      updatedAt: nowIso()
    };
    delete cancelled.lastError;
    this.deps.store.upsertCampaign(cancelled);
    return textToolResult(`Cancelled campaign ${cancelled.name}.`, {
      campaign: cancelled
    });
  }

  async siteStatus(params?: SiteStatusParams): Promise<ToolResult> {
    await this.prepareRuntime();
    const status = await this.buildSiteStatus(params ?? { verbose: false });
    return textToolResult(this.renderSiteStatus(status), status);
  }

  async logs(params: LogsParams): Promise<ToolResult> {
    await this.prepareRuntime();
    const result = await this.buildLogsResult(params);
    return textToolResult(this.renderLogs(result), result);
  }

  private async pruneArtifacts(): Promise<void> {
    const retentionHours = this.deps.config.orchestration.artifactRetentionHours;
    const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
    let removed = 0;
    for (const artifact of this.deps.store.listArtifacts()) {
      const createdAt = Date.parse(artifact.createdAt);
      if (!Number.isFinite(createdAt) || createdAt >= cutoff) {
        continue;
      }
      await rm(join(this.deps.store.resolveArtifactsDir(), artifact.relativePath), {
        force: true
      }).catch(() => undefined);
      this.deps.store.deleteArtifact(artifact.id);
      removed += 1;
    }
    if (removed > 0) {
      this.deps.logger.info(`Puppenclaw pruned ${removed} expired artifact(s).`);
    }
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.deps.store.getProject(projectId);
    if (project == null) {
      throw new PuppenclawError("UNKNOWN_PROJECT", `Unknown project ${projectId}.`);
    }
    return project;
  }

  private requireWorker(workerId: string): WorkerRecord {
    const worker = this.deps.store.getWorker(workerId);
    if (worker == null) {
      throw new PuppenclawError("UNKNOWN_WORKER", `Unknown worker ${workerId}.`);
    }
    return worker;
  }

  private requireCampaign(campaignId: string): CampaignSpecRecord {
    const campaign = this.deps.store.getCampaign(campaignId);
    if (campaign == null) {
      throw new PuppenclawError("UNKNOWN_CAMPAIGN", `Unknown campaign ${campaignId}.`);
    }
    return campaign;
  }

  private ensureCampaignCapacity(): void {
    const active = this.deps.store
      .listCampaigns()
      .filter((campaign) =>
        campaign.state === "draft" ||
        campaign.state === "running" ||
        campaign.state === "waiting_approval"
      );
    if (active.length >= this.deps.config.orchestration.maxCampaigns) {
      throw new PuppenclawError(
        "CAMPAIGN_LIMIT_REACHED",
        `Maximum active campaign limit reached (${this.deps.config.orchestration.maxCampaigns}).`
      );
    }
  }

  private ensureWorkerSupports(
    worker: WorkerRecord,
    project: ProjectRecord,
    steps: CampaignStepRecord[]
  ): void {
    if (worker.projectRoots.length > 0) {
      const allowed = worker.projectRoots.some((root) => project.rootDir.startsWith(root));
      if (!allowed) {
        throw new PuppenclawError(
          "WORKER_PROJECT_NOT_ALLOWED",
          `Worker ${worker.id} is not allowed to operate on ${project.rootDir}.`
        );
      }
    }
    const activeRuns = this.deps.store
      .listCampaigns()
      .filter((campaign) =>
        campaign.workerId === worker.id &&
        (campaign.state === "draft" ||
          campaign.state === "running" ||
          campaign.state === "waiting_approval")
      ).length;
    if (activeRuns >= worker.maxConcurrentRuns) {
      throw new PuppenclawError(
        "WORKER_CAPACITY_REACHED",
        `Worker ${worker.id} already has ${activeRuns} active campaign(s).`
      );
    }
    for (const step of steps) {
      if (!worker.supportedSteps.includes(step.kind)) {
        throw new PuppenclawError(
          "WORKER_STEP_UNSUPPORTED",
          `Worker ${worker.id} does not support ${step.kind} steps.`
        );
      }
      if (!worker.executors.includes(step.executor)) {
        throw new PuppenclawError(
          "WORKER_EXECUTOR_UNSUPPORTED",
          `Worker ${worker.id} does not support ${step.executor} execution.`
        );
      }
    }
  }

  private async prepareFusionCampaign(
    project: ProjectRecord,
    params: CampaignRunParams,
    campaignId: string
  ): Promise<{
    fusion: FusionCampaignRecord;
    steps: CampaignStepRecord[];
  }> {
    if (params.task == null || params.task.trim().length === 0) {
      throw new PuppenclawError("MISSING_TASK", "Campaign template puppenfusion requires a task.");
    }

    await this.ensureFusionEnvironment(project.rootDir, params);

    const baseRef = params.fusionBaseRef ?? "HEAD";
    const baseCommit = await this.readGitStdout(project.rootDir, ["rev-parse", baseRef]);
    const preferredAgent = params.fusionPreferredAgent
      ?? project.fusionPreferredAgent
      ?? project.defaultAgent
      ?? this.deps.config.defaultAgent;
    const bundle = await this.buildFusionBundle({
      campaignId,
      project,
      task: params.task,
      baseRef,
      baseCommit,
      preferredAgent,
      ...(params.evaluationCommand != null ? { evaluationCommand: params.evaluationCommand } : {})
    });
    const bundleRelativePath = relativeArtifactPath({
      projectId: project.id,
      campaignId,
      extension: "json",
      title: "puppenfusion-bundle"
    });
    const bundleArtifact = await this.writeTextArtifact({
      projectId: project.id,
      campaignId,
      kind: "fusion-bundle",
      title: "Puppenfusion Input Bundle",
      summary: `Sealed fusion bundle at ${baseCommit}.`,
      relativePath: bundleRelativePath,
      content: JSON.stringify(bundle, null, 2)
    });
    const worktrees = await this.createFusionWorktrees(
      project,
      campaignId,
      baseRef,
      baseCommit,
      preferredAgent
    );
    const useExternalArbiter = params.useExternalArbiter ?? false;
    if (useExternalArbiter && this.deps.config.orchestration.fusionArbiterCommand == null) {
      throw new PuppenclawError(
        "FUSION_ARBITER_MISSING",
        "useExternalArbiter requires orchestration.fusionArbiterCommand to be configured."
      );
    }

    const steps: CampaignStepRecord[] = [];
    for (const candidate of FUSION_CANDIDATES) {
      steps.push(this.normalizeStep({
        id: `fusion-implement-${candidate}`,
        title: `Implement with ${candidate}`,
        kind: "code",
        executor: "acp",
        agent: candidate,
        phaseGroup: "fusion-implement",
        sessionScope: "step",
        workingDirectory: worktrees[candidate].path,
        instruction: `Implement the sealed puppenfusion task in the ${candidate} candidate worktree and end with a structured implementation memo.`,
        fusion: {
          role: "implementation",
          candidate
        }
      }, steps.length));
    }
    if (params.evaluationCommand != null) {
      for (const candidate of FUSION_CANDIDATES) {
        steps.push(this.normalizeStep({
          id: `fusion-eval-${candidate}`,
          title: `Validate ${candidate} candidate`,
          kind: "eval",
          executor: "command",
          phaseGroup: "fusion-eval",
          workingDirectory: worktrees[candidate].path,
          command: params.evaluationCommand,
          fusion: {
            role: "candidate_eval",
            candidate
          }
        }, steps.length));
      }
    }
    for (const reviewer of FUSION_CANDIDATES) {
      const targetCandidate = reviewer === "codex" ? "claude" : "codex";
      steps.push(this.normalizeStep({
        id: `fusion-review-${reviewer}`,
        title: `${reviewer} reviews ${targetCandidate}`,
        kind: "review",
        executor: "acp",
        agent: reviewer,
        phaseGroup: "fusion-review",
        sessionScope: "step",
        workingDirectory: worktrees[targetCandidate].path,
        instruction: `Review the peer candidate critically and produce a structured report.`,
        fusion: {
          role: "peer_review",
          candidate: reviewer,
          targetCandidate
        }
      }, steps.length));
    }
    if (useExternalArbiter) {
      steps.push(this.normalizeStep({
        id: "fusion-external-arbiter",
        title: "External fusion arbiter",
        kind: "judge",
        executor: "command",
        workingDirectory: project.rootDir,
        command: this.deps.config.orchestration.fusionArbiterCommand,
        fusion: {
          role: "external_arbiter"
        }
      }, steps.length));
    }
    steps.push(this.normalizeStep({
      id: `fusion-merge-${preferredAgent}`,
      title: `Merge with ${preferredAgent}`,
      kind: "code",
      executor: "acp",
      agent: preferredAgent,
      sessionScope: "step",
      workingDirectory: worktrees.merged.path,
      instruction: `Merge the strongest ideas from both candidates into one final implementation.`,
      fusion: {
        role: "merge",
        candidate: preferredAgent
      }
    }, steps.length));
    if (params.evaluationCommand != null) {
      steps.push(this.normalizeStep({
        id: "fusion-eval-merged",
        title: "Validate merged candidate",
        kind: "eval",
        executor: "command",
        workingDirectory: worktrees.merged.path,
        command: params.evaluationCommand
      }, steps.length));
    }

    return {
      fusion: {
        baseRef,
        baseCommit,
        preferredAgent,
        useExternalArbiter,
        bundleArtifactId: bundleArtifact.id,
        bundleHash: bundleArtifact.sha256,
        worktrees
      },
      steps
    };
  }

  private buildSteps(params: CampaignRunParams): CampaignStepRecord[] {
    if (params.template === "custom") {
      if (params.steps.length === 0) {
        throw new PuppenclawError("EMPTY_CAMPAIGN", "Custom campaigns require at least one step.");
      }
      return params.steps.map((step, index) => this.normalizeStep(step, index));
    }
    if (params.task == null || params.task.trim().length === 0) {
      throw new PuppenclawError("MISSING_TASK", `Campaign template ${params.template} requires a task.`);
    }
    const steps: CampaignStepRecord[] = [];
    if (params.template === "literature_review") {
      steps.push(this.normalizeStep({
        title: "Research dossier",
        kind: "research",
        executor: "acp",
        instruction: `Produce a citation-conscious literature and landscape review for: ${params.task}`
      }, 0));
    } else if (params.template === "baseline_from_scratch") {
      steps.push(
        this.normalizeStep({
          title: "Plan implementation",
          kind: "plan",
          executor: "acp",
          instruction: `Plan the implementation strategy for: ${params.task}`
        }, 0),
        this.normalizeStep({
          title: "Implement baseline",
          kind: "code",
          executor: "acp",
          instruction: `Implement a baseline solution for: ${params.task}`
        }, 1)
      );
      if (params.evaluationCommand != null) {
        steps.push(this.normalizeStep({
          title: "Evaluate baseline",
          kind: "eval",
          executor: "command",
          command: params.evaluationCommand,
          approvalRequired: false
        }, 2));
      }
    } else if (params.template === "ablation_campaign") {
      steps.push(this.normalizeStep({
        title: "Design ablations",
        kind: "plan",
        executor: "acp",
        instruction: `Design and explain the ablation campaign for: ${params.task}`
      }, 0));
      params.experimentCommands.forEach((command, index) => {
        steps.push(this.normalizeStep({
          title: `Experiment ${index + 1}`,
          kind: "experiment",
          executor: "command",
          command
        }, index + 1));
      });
      steps.push(this.normalizeStep({
        title: "Summarize findings",
        kind: "judge",
        executor: "acp",
        instruction: `Summarize the experiment outcomes and recommend next actions for: ${params.task}`
      }, steps.length));
    } else if (params.template === "self_improvement_loop") {
      for (let index = 0; index < params.iterations; index += 1) {
        const prefix = `Iteration ${index + 1}`;
        steps.push(
          this.normalizeStep({
            title: `${prefix} planning`,
            kind: "plan",
            executor: "acp",
            instruction: `Plan the next improvement iteration for: ${params.task}`
          }, steps.length),
          this.normalizeStep({
            title: `${prefix} implementation`,
            kind: "code",
            executor: "acp",
            instruction: `Implement the next improvement iteration for: ${params.task}`
          }, steps.length + 1)
        );
        if (params.evaluationCommand != null) {
          steps.push(this.normalizeStep({
            title: `${prefix} evaluation`,
            kind: "eval",
            executor: "command",
            command: params.evaluationCommand
          }, steps.length + 2));
        }
        steps.push(this.normalizeStep({
          title: `${prefix} review`,
          kind: "review",
          executor: "acp",
          instruction: `Review the results of iteration ${index + 1} for: ${params.task}`
        }, steps.length + 3));
      }
    }
    return steps;
  }

  private normalizeStep(step: StepInput, index: number): CampaignStepRecord {
    return {
      id: step.id ?? `step-${index + 1}`,
      title: step.title,
      kind: step.kind,
      executor: step.executor,
      ...(step.instruction != null ? { instruction: step.instruction } : {}),
      ...(step.command != null ? { command: step.command } : {}),
      contextFiles: [...(step.contextFiles ?? [])],
      approvalRequired: step.approvalRequired ?? false,
      ...(step.agent != null ? { agent: step.agent } : {}),
      ...(step.phaseGroup != null ? { phaseGroup: step.phaseGroup } : {}),
      sessionScope: step.sessionScope ?? "campaign",
      ...(step.workingDirectory != null ? { workingDirectory: step.workingDirectory } : {}),
      env: { ...(step.env ?? {}) },
      ...(step.timeoutMs != null ? { timeoutMs: step.timeoutMs } : {}),
      retryLimit: step.retryLimit ?? 0,
      ...(step.fusion != null ? { fusion: step.fusion } : {})
    };
  }

  private async executeCampaign(
    campaign: CampaignSpecRecord,
    approvedStepId?: string
  ): Promise<CampaignStatusSnapshot> {
    let current = campaign;
    const project = this.requireProject(campaign.projectId);

    for (let index = current.currentStepIndex; index < current.steps.length;) {
      current = this.requireCampaign(current.id);
      const step = current.steps[index];
      if (step == null) {
        break;
      }
      if (current.state === "cancelled") {
        return this.requireSnapshot(current.id);
      }
      if (step.approvalRequired && approvedStepId !== step.id) {
        const waitingAt = nowIso();
        current = {
          ...current,
          state: "waiting_approval",
          waitingApprovalStepId: step.id,
          currentStepIndex: index,
          lastProgressAt: waitingAt,
          updatedAt: waitingAt
        };
        delete current.currentRunId;
        this.deps.store.upsertCampaign(current);
        return this.requireSnapshot(current.id);
      }

      const batch = this.collectParallelStepBatch(current, index);
      if (batch.length > 1) {
        const outcomes = await Promise.all(
          batch.map(({ step: batchStep, stepIndex }) =>
            this.executeStepRun(current, project, batchStep, stepIndex)
          )
        );
        const failed = outcomes.find((outcome) => !outcome.ok);
        if (failed != null && !failed.ok) {
          current = this.failCampaign(current, index, failed.run);
          return this.requireSnapshot(current.id);
        }
        const completed = outcomes.filter((outcome): outcome is Extract<StepRunOutcome, { ok: true }> => outcome.ok);
        const updatedAt = completed.reduce(
          (latest, outcome) => (outcome.artifact.createdAt > latest ? outcome.artifact.createdAt : latest),
          current.updatedAt
        );
        current = this.completeCampaignStep(
          current,
          index + completed.length,
          updatedAt,
          this.resolveNextCampaignSessionName(
            batch.map(({ step }) => step),
            completed.map((outcome) => outcome.run)
          )
        );
        current = await this.afterCompletedSteps(current, project, batch.map(({ step }) => step));
        index = current.currentStepIndex;
        continue;
      }

      const outcome = await this.executeStepRun(current, project, step, index);
      if (!outcome.ok) {
        current = this.failCampaign(current, index, outcome.run);
        return this.requireSnapshot(current.id);
      }
      current = this.completeCampaignStep(
        current,
        index + 1,
        outcome.artifact.createdAt,
        this.resolveNextCampaignSessionName([step], [outcome.run])
      );
      current = await this.afterCompletedSteps(current, project, [step]);
      index = current.currentStepIndex;
    }

    return this.requireSnapshot(current.id);
  }

  private collectParallelStepBatch(
    campaign: CampaignSpecRecord,
    startIndex: number
  ): Array<{ step: CampaignStepRecord; stepIndex: number }> {
    const initialStep = campaign.steps[startIndex];
    if (initialStep?.phaseGroup != null) {
      const batch: Array<{ step: CampaignStepRecord; stepIndex: number }> = [];
      for (let index = startIndex; index < campaign.steps.length; index += 1) {
        const step = campaign.steps[index];
        if (
          step == null ||
          step.phaseGroup !== initialStep.phaseGroup ||
          step.approvalRequired
        ) {
          break;
        }
        batch.push({ step, stepIndex: index });
      }
      return batch.length > 1 ? batch : [];
    }
    if (campaign.experimentParallelism <= 1) {
      return [];
    }
    const batch: Array<{ step: CampaignStepRecord; stepIndex: number }> = [];
    for (
      let index = startIndex;
      index < campaign.steps.length && batch.length < campaign.experimentParallelism;
      index += 1
    ) {
      const step = campaign.steps[index];
      if (
        step == null ||
        step.kind !== "experiment" ||
        step.executor !== "command" ||
        step.approvalRequired
      ) {
        break;
      }
      batch.push({ step, stepIndex: index });
    }
    return batch;
  }

  private async executeStepRun(
    campaign: CampaignSpecRecord,
    project: ProjectRecord,
    step: CampaignStepRecord,
    stepIndex: number
  ): Promise<StepRunOutcome> {
    const startedAt = nowIso();
    const baseRun: RunRecord = {
      id: `run-${randomUUID()}`,
      campaignId: campaign.id,
      projectId: campaign.projectId,
      workerId: campaign.workerId,
      stepId: step.id,
      stepTitle: step.title,
      stepIndex,
      kind: step.kind,
      executor: step.executor,
      state: "running",
      startedAt,
      updatedAt: startedAt,
      lastProgressAt: startedAt,
      attempts: 0
    };
    this.deps.store.upsertRun(baseRun);
    this.markCampaignRunActive(campaign, stepIndex, baseRun.id, startedAt);

    const attempt = await this.executeStepWithRetries(campaign, project, step, baseRun);
    if (!attempt.ok) {
      const failedAt = nowIso();
      const run: RunRecord = {
        ...baseRun,
        state: "failed",
        updatedAt: failedAt,
        lastProgressAt: failedAt,
        finishedAt: failedAt,
        summary: attempt.message,
        outputText: attempt.outputText,
        attempts: attempt.attempts,
        ...(attempt.failureCode != null ? { failureCode: attempt.failureCode } : {}),
        ...(attempt.failureCategory != null ? { failureCategory: attempt.failureCategory } : {})
      };
      this.deps.store.upsertRun(run);
      return { ok: false, run };
    }

    const relativePath = relativeArtifactPath({
      projectId: campaign.projectId,
      campaignId: campaign.id,
      runId: baseRun.id,
      extension: "txt",
      title: step.title
    });
    const artifact = await this.writeTextArtifact({
      projectId: campaign.projectId,
      campaignId: campaign.id,
      runId: baseRun.id,
      stepId: step.id,
      kind: attempt.result.artifactKind,
      title: attempt.result.artifactTitle,
      summary: attempt.result.summary,
      relativePath,
      content: attempt.result.outputText
    });
    for (const extraArtifact of attempt.result.extraArtifacts ?? []) {
      await this.writeTextArtifact({
        projectId: campaign.projectId,
        campaignId: campaign.id,
        runId: baseRun.id,
        stepId: step.id,
        kind: extraArtifact.kind,
        title: extraArtifact.title,
        ...(extraArtifact.summary != null ? { summary: extraArtifact.summary } : {}),
        relativePath: extraArtifact.relativePath,
        content: extraArtifact.content
      });
    }
    const run: RunRecord = {
      ...baseRun,
      state: "completed",
      updatedAt: artifact.createdAt,
      lastProgressAt: artifact.createdAt,
      finishedAt: artifact.createdAt,
      summary: attempt.result.summary,
      outputText: attempt.result.outputText,
      attempts: attempt.attempts,
      ...(attempt.result.exitCode != null ? { exitCode: attempt.result.exitCode } : {}),
      ...(attempt.result.command != null ? { command: attempt.result.command } : {}),
      ...(attempt.result.sessionName != null ? { sessionName: attempt.result.sessionName } : {})
    };
    this.deps.store.upsertRun(run);
    return {
      ok: true,
      run,
      artifact
    };
  }

  private async executeStepWithRetries(
    campaign: CampaignSpecRecord,
    project: ProjectRecord,
    step: CampaignStepRecord,
    baseRun: RunRecord
  ): Promise<StepAttemptOutcome> {
    let attempts = 0;
    while (attempts < step.retryLimit + 1) {
      attempts += 1;
      const progressAt = nowIso();
      this.deps.store.upsertRun({
        ...baseRun,
        state: "running",
        updatedAt: progressAt,
        lastProgressAt: progressAt,
        attempts,
        ...(attempts > 1 ? { summary: `Retry ${attempts} of ${step.retryLimit + 1}` } : {})
      });
      try {
        return {
          ok: true,
          attempts,
          result: await this.executeStep(campaign, project, step)
        };
      } catch (error) {
        const failure = this.describeStepFailure(error);
        if (attempts >= step.retryLimit + 1) {
          return {
            ok: false,
            attempts,
            message: failure.message,
            outputText: failure.outputText,
            ...(failure.failureCode != null ? { failureCode: failure.failureCode } : {}),
            failureCategory: failure.failureCategory
          };
        }
        const retryAt = nowIso();
        this.deps.store.upsertRun({
          ...baseRun,
          state: "running",
          updatedAt: retryAt,
          lastProgressAt: retryAt,
          attempts,
          summary: `Retrying after failure: ${failure.message}`,
          outputText: failure.outputText,
          ...(failure.failureCode != null ? { failureCode: failure.failureCode } : {}),
          ...(failure.failureCategory != null ? { failureCategory: failure.failureCategory } : {})
        });
      }
    }
    return {
      ok: false,
      attempts,
      message: "Step execution aborted unexpectedly.",
      outputText: "Step execution aborted unexpectedly.",
      failureCategory: "unknown"
    };
  }

  private async executeStep(
    campaign: CampaignSpecRecord,
    project: ProjectRecord,
    step: CampaignStepRecord
  ): Promise<StepExecutionResult> {
    if (step.kind === "research" && this.deps.config.orchestration.gptResearcherCommand != null) {
      return this.executeResearchCommandStep(campaign, project, step);
    }
    if (step.executor === "acp") {
      return this.executeAcpStep(campaign, project, step);
    }
    return this.executeCommandStep(campaign, project, step);
  }

  private markCampaignRunActive(
    campaign: CampaignSpecRecord,
    stepIndex: number,
    runId: string,
    updatedAt: string
  ): void {
    const next: CampaignSpecRecord = {
      ...campaign,
      state: "running",
      currentStepIndex: stepIndex,
      currentRunId: runId,
      lastProgressAt: updatedAt,
      updatedAt
    };
    delete next.waitingApprovalStepId;
    this.deps.store.upsertCampaign(next);
  }

  private completeCampaignStep(
    campaign: CampaignSpecRecord,
    nextStepIndex: number,
    updatedAt: string,
    sessionName?: string
  ): CampaignSpecRecord {
    const next: CampaignSpecRecord = {
      ...campaign,
      currentStepIndex: nextStepIndex,
      lastProgressAt: updatedAt,
      updatedAt,
      state: nextStepIndex >= campaign.steps.length ? "completed" : "running",
      ...(sessionName != null ? { acpSessionName: sessionName } : {})
    };
    delete next.waitingApprovalStepId;
    delete next.lastError;
    delete next.currentRunId;
    this.deps.store.upsertCampaign(next);
    return next;
  }

  private resolveNextCampaignSessionName(
    steps: CampaignStepRecord[],
    runs: RunRecord[]
  ): string | undefined {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      const run = runs[index];
      if (
        step?.executor === "acp" &&
        step.sessionScope !== "step" &&
        run?.sessionName != null
      ) {
        return run.sessionName;
      }
    }
    return undefined;
  }

  private async afterCompletedSteps(
    campaign: CampaignSpecRecord,
    project: ProjectRecord,
    steps: CampaignStepRecord[]
  ): Promise<CampaignSpecRecord> {
    if (campaign.template !== "puppenfusion" || campaign.fusion == null) {
      return campaign;
    }

    if (steps.some((step) => step.fusion?.role === "peer_review")) {
      return this.synthesizeFusionDossier(campaign, project);
    }

    if (steps.some((step) => step.fusion?.role === "external_arbiter")) {
      const arbiterStep = steps.find((step) => step.fusion?.role === "external_arbiter");
      const artifact = this.findLatestArtifact(campaign.id, {
        ...(arbiterStep?.id != null ? { stepId: arbiterStep.id } : {}),
        kind: "report"
      });
      if (artifact == null) {
        return campaign;
      }
      const next: CampaignSpecRecord = {
        ...campaign,
        fusion: {
          ...campaign.fusion,
          externalArbiterArtifactId: artifact.id
        }
      };
      this.deps.store.upsertCampaign(next);
      return next;
    }

    return campaign;
  }

  private failCampaign(
    campaign: CampaignSpecRecord,
    stepIndex: number,
    run: RunRecord
  ): CampaignSpecRecord {
    const updatedAt = run.finishedAt ?? nowIso();
    const next: CampaignSpecRecord = {
      ...campaign,
      state: "failed",
      lastError: run.summary ?? run.outputText ?? "Campaign step failed.",
      currentStepIndex: stepIndex,
      currentRunId: run.id,
      lastProgressAt: updatedAt,
      updatedAt
    };
    delete next.waitingApprovalStepId;
    this.deps.store.upsertCampaign(next);
    return next;
  }

  private async executeAcpStep(
    campaign: CampaignSpecRecord,
    project: ProjectRecord,
    step: CampaignStepRecord
  ): Promise<StepExecutionResult> {
    const sessionScope = step.sessionScope ?? "campaign";
    const sessionName = sessionScope === "step"
      ? `${slug(campaign.name)}-${step.id}-${campaign.id.slice(-6)}`
      : campaign.acpSessionName ?? `${slug(campaign.name)}-${campaign.id.slice(-8)}`;
    const selectedAgent = step.agent ?? project.defaultAgent ?? this.deps.config.defaultAgent;
    const prompt = await this.buildStepPrompt(project, campaign, step, selectedAgent);
    const startFresh = sessionScope === "step" || campaign.acpSessionName == null;
    const result = startFresh
      ? await this.deps.sessionManager.start({
          agent: selectedAgent,
          name: sessionName,
          directory: step.workingDirectory ?? project.rootDir,
          task: prompt,
          ...(project.permissionMode != null ? { permissionMode: project.permissionMode } : {}),
          ...(project.effort != null ? { effort: project.effort } : {}),
          ...(project.model != null ? { model: project.model } : {}),
          ...(project.planningProfile != null ? { planningProfile: project.planningProfile } : {}),
          contextFiles: step.contextFiles
        })
      : await this.deps.sessionManager.send({
          name: sessionName,
          message: prompt,
          contextFiles: step.contextFiles
        });
    const details = result.details as { output?: string };
    const outputText = details.output ?? result.content.map((entry) => entry.text).join("\n");
    const extraArtifacts: PendingArtifact[] = [];
    if (campaign.template === "puppenfusion" && step.fusion != null) {
      if (step.fusion.role === "implementation") {
        extraArtifacts.push(await this.captureFusionDiffArtifact(campaign, project, step, {
          kind: "candidate-diff",
          title: `${selectedAgent} candidate diff`
        }));
      } else if (step.fusion.role === "merge") {
        extraArtifacts.push(await this.captureFusionDiffArtifact(campaign, project, step, {
          kind: "candidate-diff",
          title: "Merged candidate diff"
        }));
      }
    }
    return {
      summary: summarizeText(outputText),
      outputText,
      artifactKind:
        step.fusion?.role === "implementation"
          ? "implementation-memo"
          : step.fusion?.role === "peer_review"
            ? "peer-review"
            : step.fusion?.role === "merge"
              ? "merge-summary"
              : step.kind === "research"
                ? "research-dossier"
                : "report",
      artifactTitle:
        step.fusion?.role === "implementation"
          ? `${selectedAgent} implementation memo`
          : step.fusion?.role === "peer_review"
            ? `${selectedAgent} peer review`
            : step.fusion?.role === "merge"
              ? `${selectedAgent} merged implementation summary`
              : step.title,
      sessionName,
      ...(sessionScope === "campaign" ? { nextCampaignSessionName: sessionName } : {}),
      ...(extraArtifacts.length > 0 ? { extraArtifacts } : {})
    };
  }

  private async executeCommandStep(
    campaign: CampaignSpecRecord,
    project: ProjectRecord,
    step: CampaignStepRecord
  ): Promise<StepExecutionResult> {
    if (!this.deps.config.orchestration.allowLocalCommandExecution) {
      throw new PuppenclawError(
        "COMMAND_EXECUTION_DISABLED",
        "Local command execution is disabled in orchestration config."
      );
    }
    const cwd = step.workingDirectory != null ? resolve(project.rootDir, step.workingDirectory) : project.rootDir;
    const stdinText =
      campaign.template === "puppenfusion" && step.fusion?.role === "external_arbiter"
        ? await this.buildFusionArbiterInput(campaign)
        : undefined;
    const result = await this.runShellCommand({
      campaignId: campaign.id,
      command: step.command ?? "",
      cwd,
      env: step.env,
      ...(stdinText != null ? { stdinText } : {}),
      ...(step.timeoutMs != null ? { timeoutMs: step.timeoutMs } : {})
    });
    const outputText = result.outputText;
    if (result.exitCode !== 0) {
      throw new PuppenclawError(
        "COMMAND_STEP_FAILED",
        `Command step failed with exit code ${result.exitCode}: ${summarizeText(outputText, 400)}`
      );
    }
    return {
      summary: summarizeText(outputText || `Command completed: ${basename(cwd)}`),
      outputText: outputText || `Command completed successfully in ${cwd}.`,
      artifactKind:
        campaign.template === "puppenfusion" && step.fusion?.role === "external_arbiter"
          ? "report"
          : "command-output",
      artifactTitle: step.title,
      exitCode: result.exitCode,
      ...(step.command != null ? { command: step.command } : {})
    };
  }

  private async executeResearchCommandStep(
    campaign: CampaignSpecRecord,
    project: ProjectRecord,
    step: CampaignStepRecord
  ): Promise<StepExecutionResult> {
    const command = this.deps.config.orchestration.gptResearcherCommand;
    if (command == null) {
      throw new PuppenclawError("RESEARCH_COMMAND_MISSING", "No research command is configured.");
    }
    const result = await this.runShellCommand({
      campaignId: campaign.id,
      command,
      cwd: project.rootDir,
      env: {
        PUPPENCLAW_PROJECT_ID: project.id,
        PUPPENCLAW_PROJECT_NAME: project.name,
        PUPPENCLAW_PROJECT_ROOT: project.rootDir,
        PUPPENCLAW_CAMPAIGN_ID: campaign.id,
        PUPPENCLAW_CAMPAIGN_NAME: campaign.name,
        PUPPENCLAW_STEP_ID: step.id,
        PUPPENCLAW_STEP_TITLE: step.title,
        ...(campaign.task != null ? { PUPPENCLAW_TASK: campaign.task } : {})
      },
      ...(step.timeoutMs != null ? { timeoutMs: step.timeoutMs } : {}),
      stdinText: await this.buildStepPrompt(
        project,
        campaign,
        step,
        project.defaultAgent ?? this.deps.config.defaultAgent
      )
    });
    if (result.exitCode !== 0) {
      throw new PuppenclawError(
        "RESEARCH_COMMAND_FAILED",
        `Research step failed with exit code ${result.exitCode}: ${summarizeText(result.outputText, 400)}`
      );
    }
    return {
      summary: summarizeText(result.outputText || `Research dossier generated for ${campaign.name}.`),
      outputText: result.outputText || "Research command completed without textual output.",
      artifactKind: "research-dossier",
      artifactTitle: step.title,
      exitCode: result.exitCode,
      command
    };
  }

  private buildExecutorExecutionEnvelope(params: {
    agent: AgentKind;
    planningProfile: PlanningProfile;
    permissionMode?: PermissionMode;
    effort?: EffortLevel;
    model?: string;
  }): string {
    const lines = [
      `You are the ${params.agent} execution backend for a Puppenclaw orchestration run.`,
      "Plan before writing code, then implement the project end to end unless blocked by a real decision boundary.",
      "Escalate only for scope changes, architecture forks, destructive or risky operations, missing auth/access, or unresolved ambiguity.",
      "When you continue autonomously, keep ownership and next actions explicit in your output."
    ];
    if (params.planningProfile === "deep") {
      lines.push(
        "Use a deep planning pass first: refine requirements, define scope and non-scope, outline architecture, name affected files or systems, and state the test plan before implementation."
      );
    } else if (params.planningProfile === "quick") {
      lines.push(
        "Use a short planning pass first: summarize the implementation approach, major file or system changes, and validation steps before coding."
      );
    } else {
      lines.push(
        "Planning profile is off: keep planning concise, but still avoid blind implementation when key requirements are missing."
      );
    }
    if (params.agent === "codex") {
      lines.push(
        "Craft your first response as a strong implementation brief optimized for Codex plan-mode execution: concrete scope, constraints, steps, tests, and explicit ownership."
      );
    } else {
      lines.push(
        "Use focused Claude Code behavior: keep the strategic plan explicit, keep repository-specific constraints visible, and preserve clear decision boundaries."
      );
    }
    if (params.permissionMode != null) {
      lines.push(`Operator permission mode: ${params.permissionMode}.`);
    }
    if (params.effort != null) {
      lines.push(`Requested reasoning effort: ${params.effort}.`);
    }
    if (params.model != null) {
      lines.push(`Requested model preference: ${params.model}.`);
    }
    return lines.join("\n");
  }

  private async buildStepPrompt(
    project: ProjectRecord,
    campaign: CampaignSpecRecord,
    step: CampaignStepRecord,
    agent: AgentKind
  ): Promise<string> {
    if (campaign.template === "puppenfusion" && campaign.fusion != null && step.fusion != null) {
      return this.buildFusionStepPrompt(project, campaign, step, agent);
    }
    const latestContext = await this.readLatestContextBundle(project.id);
    const planningProfile = project.planningProfile ?? "quick";
    const blocks = [
      this.buildExecutorExecutionEnvelope({
        agent,
        planningProfile,
        ...(project.permissionMode != null ? { permissionMode: project.permissionMode } : {}),
        ...(project.effort != null ? { effort: project.effort } : {}),
        ...(project.model != null ? { model: project.model } : {})
      }),
      `Project: ${project.name}`,
      `Root: ${project.rootDir}`,
      `Campaign: ${campaign.name} (${campaign.template})`,
      `Step: ${step.title} [${step.kind}]`,
      `Execution backend: ${agent}`,
      `Planning profile: ${planningProfile}`
    ];
    if (campaign.task != null) {
      blocks.push(`Top-level task:\n${campaign.task}`);
    }
    if (latestContext != null && latestContext.promptText.trim().length > 0) {
      blocks.push(latestContext.promptText);
    }
    if (step.instruction != null) {
      blocks.push(step.instruction);
    }
    return blocks.join("\n\n");
  }

  private async buildFusionStepPrompt(
    project: ProjectRecord,
    campaign: CampaignSpecRecord,
    step: CampaignStepRecord,
    agent: AgentKind
  ): Promise<string> {
    const fusion = campaign.fusion;
    const stepFusion = step.fusion;
    if (fusion == null || stepFusion == null) {
      throw new PuppenclawError("FUSION_STATE_MISSING", "Missing puppenfusion campaign state.");
    }
    const bundleText = await this.readArtifactText(campaign.id, fusion.bundleArtifactId);
    const blocks = [
      this.buildExecutorExecutionEnvelope({
        agent,
        planningProfile: project.planningProfile ?? "deep",
        ...(project.permissionMode != null ? { permissionMode: project.permissionMode } : {}),
        ...(project.effort != null ? { effort: project.effort } : {}),
        ...(project.model != null ? { model: project.model } : {})
      }),
      `Project: ${project.name}`,
      `Campaign: ${campaign.name} (puppenfusion)`,
      `Base ref: ${fusion.baseRef}`,
      `Base commit: ${fusion.baseCommit}`,
      `Bundle hash: ${shortHash(fusion.bundleHash)}`,
      `Working tree: ${step.workingDirectory ?? project.rootDir}`
    ];

    if (stepFusion.role === "implementation") {
      blocks.push(
        "You are one of two independent implementation backends in a puppenfusion run.",
        "Treat the sealed bundle below as the full source of truth.",
        "Implement the task in your assigned worktree.",
        "End your output with a structured implementation memo using these headings exactly:",
        "## Summary",
        "## Changed Areas",
        "## Decisions",
        "## Risks",
        "## Validation",
        `Sealed bundle:\n${bundleText}`
      );
      return blocks.join("\n\n");
    }

    if (stepFusion.role === "peer_review") {
      const target = stepFusion.targetCandidate;
      if (target == null) {
        throw new PuppenclawError("FUSION_REVIEW_TARGET_MISSING", "Peer review step is missing a target candidate.");
      }
      const targetMemo = await this.readFusionArtifactText(campaign.id, {
        stepId: `fusion-implement-${target}`,
        kind: "implementation-memo"
      });
      const targetDiff = await this.readFusionArtifactText(campaign.id, {
        stepId: `fusion-implement-${target}`,
        kind: "candidate-diff"
      });
      const targetValidation = this.findLatestArtifact(campaign.id, {
        stepId: `fusion-eval-${target}`,
        kind: "command-output"
      });
      blocks.push(
        `You are reviewing the ${target} candidate from a fresh session. Do not defend your own earlier implementation choices.`,
        "Produce a structured peer review with these headings exactly:",
        "## Verdict",
        "## Strengths",
        "## Weaknesses",
        "## Risks",
        "## Merge Guidance",
        `Sealed bundle:\n${bundleText}`,
        `Candidate implementation memo:\n${targetMemo}`,
        `Candidate diff snapshot:\n${targetDiff}`,
        targetValidation != null
          ? `Candidate validation output:\n${await this.readArtifactText(campaign.id, targetValidation.id)}`
          : "Candidate validation output:\n[none recorded]"
      );
      return blocks.join("\n\n");
    }

    if (stepFusion.role === "merge") {
      const codexMemo = await this.readFusionArtifactText(campaign.id, {
        stepId: "fusion-implement-codex",
        kind: "implementation-memo"
      });
      const claudeMemo = await this.readFusionArtifactText(campaign.id, {
        stepId: "fusion-implement-claude",
        kind: "implementation-memo"
      });
      const codexDiff = await this.readFusionArtifactText(campaign.id, {
        stepId: "fusion-implement-codex",
        kind: "candidate-diff"
      });
      const claudeDiff = await this.readFusionArtifactText(campaign.id, {
        stepId: "fusion-implement-claude",
        kind: "candidate-diff"
      });
      const codexReview = await this.readFusionArtifactText(campaign.id, {
        stepId: "fusion-review-codex",
        kind: "peer-review"
      });
      const claudeReview = await this.readFusionArtifactText(campaign.id, {
        stepId: "fusion-review-claude",
        kind: "peer-review"
      });
      const dossierText = fusion.dossierArtifactId != null
        ? await this.readArtifactText(campaign.id, fusion.dossierArtifactId)
        : "[fusion dossier missing]";
      const externalArbiterText = fusion.externalArbiterArtifactId != null
        ? await this.readArtifactText(campaign.id, fusion.externalArbiterArtifactId)
        : null;
      if (externalArbiterText != null) {
        blocks.push(`External arbiter:\n${externalArbiterText}`);
      }
      blocks.push(
        `You are the fixed preferred backend (${fusion.preferredAgent}) for the final puppenfusion merge run.`,
        "Implement the strongest combined result in the merged worktree.",
        "Do not merely compare. Produce the integrated implementation.",
        "End with a structured merge summary using these headings exactly:",
        "## Summary",
        "## Incorporated from Codex",
        "## Incorporated from Claude",
        "## Remaining Risks",
        "## Validation",
        `Sealed bundle:\n${bundleText}`,
        `Codex implementation memo:\n${codexMemo}`,
        `Claude implementation memo:\n${claudeMemo}`,
        `Codex diff snapshot:\n${codexDiff}`,
        `Claude diff snapshot:\n${claudeDiff}`,
        `Codex review of Claude:\n${codexReview}`,
        `Claude review of Codex:\n${claudeReview}`,
        `OpenClaw fusion dossier:\n${dossierText}`
      );
      return blocks.join("\n\n");
    }

    throw new PuppenclawError("FUSION_STEP_UNSUPPORTED", `Unsupported puppenfusion step role ${stepFusion.role}.`);
  }

  private async readLatestContextBundle(projectId: string): Promise<ProjectContextBundle | null> {
    const contextArtifact = this.deps.store
      .listArtifacts({ projectId })
      .filter((artifact) => artifact.kind === "context")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
    if (contextArtifact == null) {
      return null;
    }
    const raw = await readFile(
      join(this.deps.store.resolveArtifactsDir(), contextArtifact.relativePath),
      "utf8"
    );
    return JSON.parse(raw) as ProjectContextBundle;
  }

  private async readArtifactText(campaignId: string, artifactId: string): Promise<string> {
    const artifact = this.deps.store.listArtifacts({ campaignId }).find((entry) => entry.id === artifactId);
    if (artifact == null) {
      throw new PuppenclawError("ARTIFACT_MISSING", `Missing artifact ${artifactId}.`);
    }
    return readFile(join(this.deps.store.resolveArtifactsDir(), artifact.relativePath), "utf8");
  }

  private findLatestArtifact(
    campaignId: string,
    filters: {
      stepId?: string;
      kind?: ArtifactRecord["kind"];
    }
  ): ArtifactRecord | undefined {
    return this.deps.store
      .listArtifacts({ campaignId })
      .filter((artifact) =>
        (filters.stepId == null || artifact.stepId === filters.stepId) &&
        (filters.kind == null || artifact.kind === filters.kind)
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
  }

  private async readFusionArtifactText(
    campaignId: string,
    filters: {
      stepId: string;
      kind: ArtifactRecord["kind"];
    }
  ): Promise<string> {
    const artifact = this.findLatestArtifact(campaignId, filters);
    if (artifact == null) {
      throw new PuppenclawError(
        "FUSION_ARTIFACT_MISSING",
        `Missing fusion artifact ${filters.kind} for ${filters.stepId}.`
      );
    }
    return this.readArtifactText(campaignId, artifact.id);
  }

  private async buildFusionArbiterInput(campaign: CampaignSpecRecord): Promise<string> {
    if (campaign.fusion?.dossierArtifactId == null) {
      throw new PuppenclawError("FUSION_DOSSIER_MISSING", "Fusion dossier is not available yet.");
    }
    return this.readArtifactText(campaign.id, campaign.fusion.dossierArtifactId);
  }

  private async synthesizeFusionDossier(
    campaign: CampaignSpecRecord,
    project: ProjectRecord
  ): Promise<CampaignSpecRecord> {
    if (campaign.fusion == null) {
      return campaign;
    }
    const codexMemo = await this.readFusionArtifactText(campaign.id, {
      stepId: "fusion-implement-codex",
      kind: "implementation-memo"
    });
    const claudeMemo = await this.readFusionArtifactText(campaign.id, {
      stepId: "fusion-implement-claude",
      kind: "implementation-memo"
    });
    const codexReview = await this.readFusionArtifactText(campaign.id, {
      stepId: "fusion-review-codex",
      kind: "peer-review"
    });
    const claudeReview = await this.readFusionArtifactText(campaign.id, {
      stepId: "fusion-review-claude",
      kind: "peer-review"
    });
    const codexValidation = this.findLatestArtifact(campaign.id, {
      stepId: "fusion-eval-codex",
      kind: "command-output"
    });
    const claudeValidation = this.findLatestArtifact(campaign.id, {
      stepId: "fusion-eval-claude",
      kind: "command-output"
    });
    const dossier = [
      `# Puppenfusion Dossier`,
      ``,
      `Project: ${project.name}`,
      `Campaign: ${campaign.name}`,
      `Base commit: ${campaign.fusion.baseCommit}`,
      `Preferred merge backend: ${campaign.fusion.preferredAgent}`,
      ``,
      `## Codex Candidate`,
      summarizeText(codexMemo, 1_200),
      ``,
      `## Claude Candidate`,
      summarizeText(claudeMemo, 1_200),
      ``,
      `## Codex Review Of Claude`,
      summarizeText(codexReview, 1_200),
      ``,
      `## Claude Review Of Codex`,
      summarizeText(claudeReview, 1_200),
      ``,
      `## Validation Signals`,
      `- Codex: ${codexValidation != null ? summarizeText(await this.readArtifactText(campaign.id, codexValidation.id), 400) : "no evaluation command recorded"}`,
      `- Claude: ${claudeValidation != null ? summarizeText(await this.readArtifactText(campaign.id, claudeValidation.id), 400) : "no evaluation command recorded"}`,
      ``,
      `## Merge Guidance`,
      `- Preserve ideas that both implementations or both reviews converge on.`,
      `- Prefer the lower-risk path when only one candidate argues for a change.`,
      `- Use the fixed preferred backend only for the final merge run, not as evidence weighting.`,
      `- Return to the human only if the merge reveals a real scope, safety, or architecture fork.`
    ].join("\n");
    const relativePath = relativeArtifactPath({
      projectId: project.id,
      campaignId: campaign.id,
      extension: "md",
      title: "fusion-dossier"
    });
    const artifact = await this.writeTextArtifact({
      projectId: project.id,
      campaignId: campaign.id,
      kind: "fusion-dossier",
      title: "Fusion dossier",
      summary: `OpenClaw synthesis for ${campaign.name}.`,
      relativePath,
      content: dossier
    });
    const next: CampaignSpecRecord = {
      ...campaign,
      fusion: {
        ...campaign.fusion,
        dossierArtifactId: artifact.id
      }
    };
    this.deps.store.upsertCampaign(next);
    return next;
  }

  private async captureFusionDiffArtifact(
    campaign: CampaignSpecRecord,
    project: ProjectRecord,
    step: CampaignStepRecord,
    params: {
      kind: ArtifactRecord["kind"];
      title: string;
    }
  ): Promise<PendingArtifact> {
    const worktree = step.workingDirectory ?? project.rootDir;
    const status = await this.readGitStdout(worktree, ["status", "--short", "--untracked-files=all"]);
    const diff = await this.readGitStdout(worktree, ["diff", "--no-ext-diff", "--binary"]);
    const content = [
      `# ${params.title}`,
      ``,
      `## Working tree`,
      worktree,
      ``,
      `## Git status`,
      status.trim().length > 0 ? status : "[no changes recorded]",
      ``,
      `## Git diff`,
      diff.trim().length > 0 ? diff : "[no diff recorded]"
    ].join("\n");
    return {
      kind: params.kind,
      title: params.title,
      summary: summarizeText(status || diff || "No changes recorded.", 220),
      relativePath: relativeArtifactPath({
        projectId: project.id,
        campaignId: campaign.id,
        extension: "patch",
        title: params.title
      }),
      content
    };
  }

  private async buildFusionBundle(params: {
    campaignId: string;
    project: ProjectRecord;
    task: string;
    baseRef: string;
    baseCommit: string;
    preferredAgent: FusionCandidate;
    evaluationCommand?: string;
  }): Promise<FusionBundle> {
    const latestContext = await this.readLatestContextBundle(params.project.id);
    const latestContextArtifact = this.deps.store
      .listArtifacts({ projectId: params.project.id })
      .filter((artifact) => artifact.kind === "context")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
    return {
      campaignId: params.campaignId,
      projectId: params.project.id,
      projectName: params.project.name,
      rootDir: params.project.rootDir,
      createdAt: nowIso(),
      baseRef: params.baseRef,
      baseCommit: params.baseCommit,
      task: params.task,
      ...(params.evaluationCommand != null ? { evaluationCommand: params.evaluationCommand } : {}),
      ...(latestContextArtifact != null ? { contextBundleArtifactId: latestContextArtifact.id } : {}),
      ...(latestContext?.promptText.trim().length
        ? { contextPromptText: latestContext.promptText }
        : {}),
      preferredAgent: params.preferredAgent,
      decisionPolicy:
        "Continue autonomously until a real scope, safety, or architecture fork requires returning to the human."
    };
  }

  private async ensureFusionEnvironment(
    rootDir: string,
    params: CampaignRunParams
  ): Promise<void> {
    await this.ensureGitRepoClean(rootDir);
    if (params.useExternalArbiter && this.deps.config.orchestration.fusionArbiterCommand == null) {
      throw new PuppenclawError(
        "FUSION_ARBITER_MISSING",
        "External arbitration was requested, but no fusion arbiter command is configured."
      );
    }
    await this.ensureCommandAvailable(this.deps.config.acpxCommand ?? "acpx");
    for (const candidate of FUSION_CANDIDATES) {
      await this.ensureCommandAvailable(
        this.deps.config.agentCommands[candidate] ?? DEFAULT_ACPX_AGENT_COMMANDS[candidate]
      );
    }
  }

  private async ensureGitRepoClean(rootDir: string): Promise<void> {
    await this.readGitStdout(rootDir, ["rev-parse", "--show-toplevel"]);
    const status = await this.readGitStdout(rootDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.trim().length > 0) {
      throw new PuppenclawError(
        "FUSION_REPO_DIRTY",
        "puppenfusion requires a clean git worktree before campaign start."
      );
    }
  }

  private async createFusionWorktrees(
    project: ProjectRecord,
    campaignId: string,
    baseRef: string,
    baseCommit: string,
    preferredAgent: FusionCandidate
  ): Promise<Record<FusionCandidate, FusionWorktreeRecord> & { merged: FusionWorktreeRecord }> {
    const root = join(this.deps.store.rootDir, "worktrees", campaignId);
    await ensureDir(root);
    const worktrees = {} as Record<FusionCandidate, FusionWorktreeRecord> & {
      merged: FusionWorktreeRecord;
    };
    for (const candidate of [...FUSION_CANDIDATES, "merged"] as const) {
      const branch = `puppenfusion-${campaignId}-${candidate}`;
      const path = join(root, candidate);
      await this.runGit(project.rootDir, ["worktree", "add", "--detach", path, baseCommit]);
      await this.runGit(path, ["checkout", "-b", branch]);
      worktrees[candidate] = {
        agent: candidate === "merged" ? preferredAgent : candidate,
        path,
        branch,
        baseRef,
        baseCommit
      };
    }
    return worktrees;
  }

  private async ensureCommandAvailable(commandText: string): Promise<void> {
    const executable = this.extractExecutable(commandText);
    const result = await this.runShellCommand({
      campaignId: "validation",
      command: `command -v ${this.shellQuote(executable)}`,
      cwd: process.cwd()
    });
    if (result.exitCode !== 0) {
      throw new PuppenclawError(
        "COMMAND_NOT_AVAILABLE",
        `Required command is not available on PATH: ${executable}`
      );
    }
  }

  private extractExecutable(commandText: string): string {
    const parts = commandText.trim().split(/\s+/u).filter(Boolean);
    for (const part of parts) {
      if (part === "env" || part.includes("=")) {
        continue;
      }
      return part;
    }
    return commandText.trim();
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/gu, `'\"'\"'`)}'`;
  }

  private async readGitStdout(cwd: string, args: string[]): Promise<string> {
    const result = await this.runGit(cwd, args);
    if (result.exitCode !== 0) {
      throw new PuppenclawError(
        "GIT_COMMAND_FAILED",
        `git ${args.join(" ")} failed: ${summarizeText(result.outputText, 400)}`
      );
    }
    return result.stdout;
  }

  private async runGit(
    cwd: string,
    args: string[]
  ): Promise<ShellCommandResult> {
    return this.runProcess({
      campaignId: "git",
      command: "git",
      args,
      cwd,
      env: {}
    });
  }

  private async writeArtifactFile(relativePath: string, content: string): Promise<{
    sizeBytes: number;
    sha256: string;
  }> {
    const targetPath = join(this.deps.store.resolveArtifactsDir(), relativePath);
    await ensureDir(dirname(targetPath));
    const normalized = normalizeArtifactContent(content);
    await writeFile(targetPath, normalized, "utf8");
    return {
      sizeBytes: Buffer.byteLength(normalized, "utf8"),
      sha256: hashTextContent(normalized)
    };
  }

  private async writeTextArtifact(params: {
    projectId: string;
    campaignId?: string;
    runId?: string;
    stepId?: string;
    kind: ArtifactRecord["kind"];
    title: string;
    summary?: string;
    relativePath: string;
    content: string;
  }): Promise<ArtifactRecord> {
    const file = await this.writeArtifactFile(params.relativePath, params.content);
    const artifact: ArtifactRecord = {
      id: `art-${randomUUID()}`,
      createdAt: nowIso(),
      projectId: params.projectId,
      ...(params.campaignId != null ? { campaignId: params.campaignId } : {}),
      ...(params.runId != null ? { runId: params.runId } : {}),
      ...(params.stepId != null ? { stepId: params.stepId } : {}),
      siteId: this.siteId,
      kind: params.kind,
      title: params.title,
      ...(params.summary != null ? { summary: params.summary } : {}),
      relativePath: params.relativePath,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      files: [
        {
          relativePath: params.relativePath,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256
        }
      ]
    };
    this.deps.store.upsertArtifact(artifact);
    return artifact;
  }

  private async runShellCommand(params: {
    campaignId: string;
    command: string;
    cwd: string;
    env?: Record<string, string>;
    stdinText?: string;
    timeoutMs?: number;
  }): Promise<ShellCommandResult> {
    return this.runProcess({
      campaignId: params.campaignId,
      command: "bash",
      args: ["-lc", params.command],
      cwd: params.cwd,
      ...(params.env != null ? { env: params.env } : {}),
      ...(params.stdinText != null ? { stdinText: params.stdinText } : {}),
      ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {})
    });
  }

  private async runProcess(params: {
    campaignId: string;
    command: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    stdinText?: string;
    timeoutMs?: number;
  }): Promise<ShellCommandResult> {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: {
        ...process.env,
        ...params.env
      }
    });
    const children = this.activeCommands.get(params.campaignId) ?? new Set<ChildProcessWithoutNullStreams>();
    children.add(child);
    this.activeCommands.set(params.campaignId, children);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    if (params.stdinText != null) {
      child.stdin.write(params.stdinText);
    }
    child.stdin.end();
    let timedOut = false;
    const timeoutHandle = params.timeoutMs != null
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, params.timeoutMs)
      : null;
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveExit(code ?? 0));
    }).finally(() => {
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle);
      }
      children.delete(child);
      if (children.size === 0) {
        this.activeCommands.delete(params.campaignId);
      }
    });
    const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
    const stderrText = Buffer.concat(stderr).toString("utf8").trim();
    const outputText = [stdoutText, stderrText].filter(Boolean).join("\n").trim();
    if (timedOut) {
      throw new PuppenclawError(
        "COMMAND_STEP_TIMEOUT",
        `Command step timed out after ${params.timeoutMs}ms: ${summarizeText(outputText || `${params.command} ${params.args.join(" ")}`, 400)}`
      );
    }
    return {
      exitCode,
      stdout: stdoutText,
      stderr: stderrText,
      outputText
    };
  }

  private async buildSiteStatus(params: SiteStatusParams): Promise<SiteStatus> {
    const sessions = this.deps.sessionStore.listSessions();
    const campaigns = this.deps.store.listCampaigns();
    const workers = this.deps.store.listWorkers();
    const exposures = this.deps.sessionStore.listExposures();
    return {
      siteId: this.siteId,
      label: this.deps.config.orchestration.localWorker.label,
      backend: this.deps.config.backend,
      pluginHealth: "ok",
      openclawRuntime: {
        available: true
      },
      defaultAgent: this.deps.config.defaultAgent,
      availableAgents: this.resolveAvailableAgents(),
      orchestration: {
        enabled: this.deps.config.orchestration.enabled,
        allowLocalCommandExecution: this.deps.config.orchestration.allowLocalCommandExecution,
        ...(this.deps.config.orchestration.defaultProjectRoot != null
          ? { defaultProjectRoot: this.deps.config.orchestration.defaultProjectRoot }
          : {}),
        projectRoots: this.collectProjectRoots(workers)
      },
      sessions: {
        maxSessions: this.deps.config.maxSessions,
        total: sessions.length,
        active: sessions.filter((session) => ["idle", "running", "waiting_input"].includes(session.state)).length,
        streamOutputSupported: this.deps.config.streamOutput,
        logTailingSupported: false,
        ...(params.verbose
          ? {
              items: sessions.map((session) => ({
                name: session.name,
                agent: session.agent,
                directory: session.directory,
                state: session.state,
                lastActivity: session.lastActivity,
                ...(session.source != null ? { sourceKind: session.source.kind } : {})
              }))
            }
          : {})
      },
      campaigns: {
        maxCampaigns: this.deps.config.orchestration.maxCampaigns,
        total: campaigns.length,
        active: campaigns.filter((campaign) =>
          campaign.state === "draft" ||
          campaign.state === "running" ||
          campaign.state === "waiting_approval"
        ).length,
        ...(params.verbose
          ? {
              items: campaigns.map((campaign) => ({
                id: campaign.id,
                name: campaign.name,
                projectId: campaign.projectId,
                workerId: campaign.workerId,
                template: campaign.template,
                state: campaign.state,
                currentStepIndex: campaign.currentStepIndex,
                experimentParallelism: campaign.experimentParallelism,
                lastProgressAt: campaign.lastProgressAt,
                ...(campaign.lastError != null ? { lastError: campaign.lastError } : {})
              }))
            }
          : {})
      },
      workers: workers.map((worker) => ({
        id: worker.id,
        label: worker.label,
        labels: worker.labels,
        projectRoots: worker.projectRoots,
        supportedSteps: worker.supportedSteps,
        executors: worker.executors,
        ...(worker.defaultAgent != null ? { defaultAgent: worker.defaultAgent } : {}),
        maxConcurrentRuns: worker.maxConcurrentRuns,
        activeCampaigns: campaigns.filter((campaign) =>
          campaign.workerId === worker.id &&
          (campaign.state === "draft" ||
            campaign.state === "running" ||
            campaign.state === "waiting_approval")
        ).length
      })),
      exposures: {
        total: exposures.length,
        currentExposure: null,
        ...(params.verbose ? { items: exposures } : {})
      }
    };
  }

  private async buildLogsResult(params: LogsParams): Promise<LogsResult> {
    if (params.sessionName != null) {
      const session = this.deps.sessionStore.getSession(params.sessionName);
      if (session == null) {
        throw new PuppenclawError("UNKNOWN_SESSION", `Unknown session ${params.sessionName}.`);
      }
      const text = trimLogText(transcriptToLogText(session.transcript), params.limitChars);
      return {
        scope: "session",
        targetId: session.name,
        limitChars: params.limitChars,
        followRequested: params.follow,
        followSupported: false,
        text,
        entries: [
          {
            id: session.name,
            title: `${session.name} (${session.agent})`,
            state: session.state,
            updatedAt: session.lastActivity,
            text
          }
        ]
      };
    }

    if (params.runId != null) {
      const run = this.deps.store.getRun(params.runId);
      if (run == null) {
        throw new PuppenclawError("UNKNOWN_RUN", `Unknown run ${params.runId}.`);
      }
      const text = trimLogText(run.outputText ?? run.summary ?? "", params.limitChars);
      return {
        scope: "run",
        targetId: run.id,
        limitChars: params.limitChars,
        followRequested: params.follow,
        followSupported: false,
        text,
        entries: [
          {
            id: run.id,
            title: run.stepTitle,
            state: run.state,
            updatedAt: run.updatedAt,
            text
          }
        ]
      };
    }

    const campaign = this.requireCampaign(params.campaignId as string);
    const runs = this.deps.store.listRuns(campaign.id);
    const entries = runs.map((run) => {
      const text = trimLogText(run.outputText ?? run.summary ?? "", params.limitChars);
      return {
        id: run.id,
        title: `${run.stepTitle} (#${run.stepIndex + 1})`,
        state: run.state,
        updatedAt: run.updatedAt,
        text
      };
    });
    const combined = trimLogText(
      entries
        .map((entry) => `## ${entry.title}\n${entry.text}`)
        .join("\n\n"),
      params.limitChars
    );
    return {
      scope: "campaign",
      targetId: campaign.id,
      limitChars: params.limitChars,
      followRequested: params.follow,
      followSupported: false,
      text: combined,
      entries
    };
  }

  private renderSiteStatus(status: SiteStatus): string {
    return [
      `Site ${status.label} (${status.siteId})`,
      `backend: ${status.backend}`,
      `sessions: ${status.sessions.active}/${status.sessions.total} active (max ${status.sessions.maxSessions})`,
      `campaigns: ${status.campaigns.active}/${status.campaigns.total} active (max ${status.campaigns.maxCampaigns})`,
      `workers: ${status.workers.length}`,
      `exposures: ${status.exposures.total}`
    ].join("\n");
  }

  private renderLogs(result: LogsResult): string {
    return [
      `Logs for ${result.scope} ${result.targetId}`,
      result.text || "[no log output recorded]"
    ].join("\n\n");
  }

  private resolveAvailableAgents(): SiteAgentAvailability[] {
    return (["claude", "codex"] as const).map((agent) => ({
      agent,
      command:
        this.deps.config.agentCommands[agent] ??
        this.deps.config.acpxCommand ??
        (agent === "claude"
          ? "npx -y @zed-industries/claude-agent-acp"
          : "npx @zed-industries/codex-acp"),
      configured: true
    }));
  }

  private collectProjectRoots(workers: WorkerRecord[]): string[] {
    const projectRoots = new Set<string>();
    for (const worker of workers) {
      for (const root of worker.projectRoots) {
        projectRoots.add(root);
      }
    }
    if (
      projectRoots.size === 0 &&
      this.deps.config.orchestration.defaultProjectRoot != null
    ) {
      projectRoots.add(resolve(this.deps.config.orchestration.defaultProjectRoot));
    }
    return [...projectRoots];
  }

  private describeStepFailure(error: unknown): {
    message: string;
    outputText: string;
    failureCode?: string;
    failureCategory: RunRecord["failureCategory"];
  } {
    if (error instanceof PuppenclawError) {
      return {
        message: error.message,
        outputText: error.message,
        failureCode: error.code,
        failureCategory:
          error.code.includes("TIMEOUT")
            ? "timeout"
            : error.code.includes("VALID")
              ? "validation"
              : error.code.includes("COMMAND") || error.code.includes("RESEARCH")
                ? "execution"
                : "unknown"
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      message,
      outputText: message,
      failureCategory: "unknown"
    };
  }

  private get siteId(): string {
    return this.deps.config.orchestration.localWorker.id;
  }

  private requireSnapshot(campaignId: string): CampaignStatusSnapshot {
    const snapshot = this.deps.store.getCampaignSnapshot(campaignId);
    if (snapshot == null) {
      throw new PuppenclawError("UNKNOWN_CAMPAIGN", `Unknown campaign ${campaignId}.`);
    }
    return snapshot;
  }
}
