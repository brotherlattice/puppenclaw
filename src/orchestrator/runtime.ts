import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/core";

import type { ISessionManager } from "../manager/interface.js";
import { PuppenclawError } from "../shared/errors.js";
import { jsonToolResult, textToolResult } from "../shared/tool-results.js";
import type {
  ArtifactListParams,
  CampaignActionParams,
  CampaignRunParams,
  CampaignStatusParams,
  ContextSyncParams,
  ParsedPluginConfig,
  ProjectCreateParams,
  ToolResult,
  WorkerManifestInput
} from "../shared/types.js";
import { ensureDir, loadContextFiles, nowIso, pathExists } from "../shared/utils.js";
import { OrchestratorStore } from "./store.js";
import type {
  ArtifactRecord,
  CampaignSpecRecord,
  CampaignStatusSnapshot,
  CampaignStepRecord,
  IOrchestrator,
  ProjectContextBundle,
  ProjectRecord,
  RunRecord,
  WorkerRecord
} from "./types.js";

type StepExecutionResult = {
  summary: string;
  outputText: string;
  artifactKind: ArtifactRecord["kind"];
  artifactTitle: string;
  exitCode?: number;
  sessionName?: string;
  command?: string;
};

type ShellCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputText: string;
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
  workingDirectory?: string | undefined;
  env?: Record<string, string> | undefined;
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
  private readonly activeCommands = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly deps: {
      config: ParsedPluginConfig;
      store: OrchestratorStore;
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
    await this.writeArtifactFile(relativePath, JSON.stringify(bundle, null, 2));
    const artifact = await this.recordArtifact({
      projectId: project.id,
      kind: "context",
      title: "Context Bundle",
      relativePath
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
    this.ensureCampaignCapacity();
    const steps = this.buildSteps(params);
    this.ensureWorkerSupports(worker, project, steps);
    const now = nowIso();
    const campaignId = `camp-${randomUUID()}`;
    const campaign: CampaignSpecRecord = {
      id: campaignId,
      projectId: project.id,
      workerId: worker.id,
      name: params.name,
      template: params.template,
      ...(params.task != null ? { task: params.task } : {}),
      ...(params.evaluationCommand != null ? { evaluationCommand: params.evaluationCommand } : {}),
      experimentCommands: [...params.experimentCommands],
      iterations: params.iterations,
      steps,
      currentStepIndex: 0,
      createdAt: now,
      updatedAt: now,
      state: "running"
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
    const resumed: CampaignSpecRecord = {
      ...campaign,
      state: "running",
      updatedAt: nowIso()
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
      active.kill("SIGTERM");
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
      ...(step.workingDirectory != null ? { workingDirectory: step.workingDirectory } : {}),
      env: { ...(step.env ?? {}) }
    };
  }

  private async executeCampaign(
    campaign: CampaignSpecRecord,
    approvedStepId?: string
  ): Promise<CampaignStatusSnapshot> {
    let current = campaign;
    const project = this.requireProject(campaign.projectId);

    for (let index = current.currentStepIndex; index < current.steps.length; index += 1) {
      const step = current.steps[index];
      if (step == null) {
        break;
      }
      if (current.state === "cancelled") {
        break;
      }
      if (step.approvalRequired && approvedStepId !== step.id) {
        current = {
          ...current,
          state: "waiting_approval",
          waitingApprovalStepId: step.id,
          currentStepIndex: index,
          updatedAt: nowIso()
        };
        this.deps.store.upsertCampaign(current);
        return this.requireSnapshot(current.id);
      }

      const runId = `run-${randomUUID()}`;
      const baseRun: RunRecord = {
        id: runId,
        campaignId: current.id,
        projectId: current.projectId,
        workerId: current.workerId,
        stepId: step.id,
        stepTitle: step.title,
        kind: step.kind,
        executor: step.executor,
        state: "running",
        startedAt: nowIso(),
        updatedAt: nowIso()
      };
      this.deps.store.upsertRun(baseRun);
      try {
        const result =
          step.kind === "research" && this.deps.config.orchestration.gptResearcherCommand != null
            ? await this.executeResearchCommandStep(current, project, step)
            : step.executor === "acp"
              ? await this.executeAcpStep(current, project, step)
              : await this.executeCommandStep(current, project, step);
        const relativePath = relativeArtifactPath({
          projectId: current.projectId,
          campaignId: current.id,
          runId,
          extension: "txt",
          title: step.title
        });
        await this.writeArtifactFile(relativePath, result.outputText);
        const artifact = await this.recordArtifact({
          projectId: current.projectId,
          campaignId: current.id,
          runId,
          kind: result.artifactKind,
          title: result.artifactTitle,
          relativePath
        });
        this.deps.store.upsertRun({
          ...baseRun,
          state: "completed",
          updatedAt: nowIso(),
          finishedAt: nowIso(),
          summary: result.summary,
          outputText: result.outputText,
          ...(result.exitCode != null ? { exitCode: result.exitCode } : {}),
          ...(result.command != null ? { command: result.command } : {}),
          ...(result.sessionName != null ? { sessionName: result.sessionName } : {})
        });
        current = {
          ...current,
          currentStepIndex: index + 1,
          ...(result.sessionName != null ? { acpSessionName: result.sessionName } : {}),
          updatedAt: artifact.createdAt,
          state: index + 1 >= current.steps.length ? "completed" : "running"
        };
        delete current.waitingApprovalStepId;
        delete current.lastError;
        this.deps.store.upsertCampaign(current);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.store.upsertRun({
          ...baseRun,
          state: "failed",
          updatedAt: nowIso(),
          finishedAt: nowIso(),
          summary: message,
          outputText: message
        });
        current = {
          ...current,
          state: "failed",
          lastError: message,
          currentStepIndex: index,
          updatedAt: nowIso()
        };
        this.deps.store.upsertCampaign(current);
        return this.requireSnapshot(current.id);
      }
    }

    return this.requireSnapshot(current.id);
  }

  private async executeAcpStep(
    campaign: CampaignSpecRecord,
    project: ProjectRecord,
    step: CampaignStepRecord
  ): Promise<StepExecutionResult> {
    const sessionName = campaign.acpSessionName ?? `${slug(campaign.name)}-${campaign.id.slice(-8)}`;
    const prompt = await this.buildStepPrompt(project, campaign, step);
    const result = campaign.acpSessionName == null
      ? await this.deps.sessionManager.start({
          agent: step.agent ?? this.deps.config.defaultAgent,
          name: sessionName,
          directory: project.rootDir,
          task: prompt,
          contextFiles: step.contextFiles
        })
      : await this.deps.sessionManager.send({
          name: sessionName,
          message: prompt,
          contextFiles: step.contextFiles
        });
    const details = result.details as { output?: string };
    const outputText = details.output ?? result.content.map((entry) => entry.text).join("\n");
    return {
      summary: summarizeText(outputText),
      outputText,
      artifactKind: step.kind === "research" ? "research-dossier" : "report",
      artifactTitle: step.title,
      sessionName
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
    const result = await this.runShellCommand({
      campaignId: campaign.id,
      command: step.command ?? "",
      cwd,
      env: step.env
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
      artifactKind: "command-output",
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
      stdinText: await this.buildStepPrompt(project, campaign, step)
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

  private async buildStepPrompt(
    project: ProjectRecord,
    campaign: CampaignSpecRecord,
    step: CampaignStepRecord
  ): Promise<string> {
    const latestContext = await this.readLatestContextBundle(project.id);
    const blocks = [
      `Project: ${project.name}`,
      `Root: ${project.rootDir}`,
      `Campaign: ${campaign.name} (${campaign.template})`,
      `Step: ${step.title} [${step.kind}]`
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

  private async writeArtifactFile(relativePath: string, content: string): Promise<void> {
    const targetPath = join(this.deps.store.resolveArtifactsDir(), relativePath);
    await ensureDir(dirname(targetPath));
    await writeFile(targetPath, `${content.trimEnd()}\n`, "utf8");
  }

  private async recordArtifact(params: Omit<ArtifactRecord, "id" | "createdAt" | "sizeBytes">): Promise<ArtifactRecord> {
    const artifact: ArtifactRecord = {
      id: `art-${randomUUID()}`,
      createdAt: nowIso(),
      sizeBytes: 0,
      ...params
    };
    artifact.sizeBytes = await this.deps.store.captureArtifactSize(artifact.relativePath);
    this.deps.store.upsertArtifact(artifact);
    return artifact;
  }

  private async runShellCommand(params: {
    campaignId: string;
    command: string;
    cwd: string;
    env?: Record<string, string>;
    stdinText?: string;
  }): Promise<ShellCommandResult> {
    const child = spawn("bash", ["-lc", params.command], {
      cwd: params.cwd,
      env: {
        ...process.env,
        ...params.env
      }
    });
    this.activeCommands.set(params.campaignId, child);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    if (params.stdinText != null) {
      child.stdin.write(params.stdinText);
    }
    child.stdin.end();
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveExit(code ?? 0));
    }).finally(() => {
      this.activeCommands.delete(params.campaignId);
    });
    const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
    const stderrText = Buffer.concat(stderr).toString("utf8").trim();
    return {
      exitCode,
      stdout: stdoutText,
      stderr: stderrText,
      outputText: [stdoutText, stderrText].filter(Boolean).join("\n").trim()
    };
  }

  private requireSnapshot(campaignId: string): CampaignStatusSnapshot {
    const snapshot = this.deps.store.getCampaignSnapshot(campaignId);
    if (snapshot == null) {
      throw new PuppenclawError("UNKNOWN_CAMPAIGN", `Unknown campaign ${campaignId}.`);
    }
    return snapshot;
  }
}
