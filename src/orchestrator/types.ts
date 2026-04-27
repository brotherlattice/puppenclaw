import type {
  AgentKind,
  CampaignState,
  CampaignTemplate,
  EffortLevel,
  OrchestrationExecutor,
  OrchestrationStepKind,
  PermissionMode,
  PlanningProfile,
  ReassessmentProvider,
  ReassessmentState,
  RunState,
  WorkerManifestInput
} from "../shared/types.js";

export type ProjectRecord = {
  id: string;
  name: string;
  rootDir: string;
  description?: string;
  defaultAgent?: AgentKind;
  fusionPreferredAgent?: AgentKind;
  planningProfile?: PlanningProfile;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  model?: string;
  createdAt: string;
  updatedAt: string;
  lastContextSyncAt?: string;
};

export type WorkerRecord = WorkerManifestInput & {
  createdAt: string;
  updatedAt: string;
};

export type ProjectContextBundle = {
  projectId: string;
  projectName: string;
  rootDir: string;
  createdAt: string;
  includeFiles: Array<{
    path: string;
    resolvedPath: string;
    bytes: number;
    truncated: boolean;
  }>;
  notes?: string;
  memoryText?: string;
  promptText: string;
};

export type CampaignStepRecord = {
  id: string;
  title: string;
  kind: OrchestrationStepKind;
  executor: OrchestrationExecutor;
  instruction?: string;
  command?: string;
  contextFiles: string[];
  approvalRequired: boolean;
  agent?: AgentKind;
  phaseGroup?: string;
  sessionScope?: "campaign" | "step";
  workingDirectory?: string;
  env: Record<string, string>;
  timeoutMs?: number;
  retryLimit: number;
  fusion?: FusionStepConfig;
};

export type FusionCandidate = Extract<AgentKind, "claude" | "codex">;

export type FusionPhase =
  | "plan"
  | "implement"
  | "candidate_eval"
  | "peer_review"
  | "integration"
  | "merged_eval";

export type FusionApprovalState = "not_required" | "waiting" | "approved";

export type FusionIntegrationState = "pending" | "succeeded" | "conflict" | "resolved";

export type FusionStepConfig = {
  role:
    | "planning"
    | "approval_gate"
    | "implementation"
    | "candidate_eval"
    | "peer_review"
    | "external_arbiter"
    | "integration"
    | "merge";
  candidate?: FusionCandidate;
  targetCandidate?: FusionCandidate;
};

export type FusionWorktreeRecord = {
  agent: FusionCandidate;
  path: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
};

export type FusionCampaignRecord = {
  baseRef: string;
  baseCommit: string;
  preferredAgent: FusionCandidate;
  useExternalArbiter: boolean;
  bundleArtifactId: string;
  bundleHash: string;
  currentPhase: FusionPhase;
  approvalState: FusionApprovalState;
  integrationState: FusionIntegrationState;
  resolverUsed: boolean;
  worktrees: Record<FusionCandidate, FusionWorktreeRecord> & {
    merged: FusionWorktreeRecord;
  };
  planArtifactId?: string;
  dossierArtifactId?: string;
  externalArbiterArtifactId?: string;
  approvalGrantedAt?: string;
  lastCompletedPhase?: FusionPhase;
  candidateStates: Partial<Record<FusionCandidate, FusionCandidateRecord>>;
  events: FusionEventRecord[];
  phaseSummaries: FusionPhaseSummaryRecord[];
};

export type FusionCandidateRecord = {
  status: "candidate" | "noop" | "abort" | "interrupted";
  agent: FusionCandidate;
  baseCommit: string;
  worktreePath: string;
  summary: string;
  memoArtifactId: string;
  diffArtifactId?: string;
  validationArtifactId?: string;
  createdAt: string;
  artifactId?: string;
  candidateCommit?: string;
};

export type FusionEventRecord = {
  type:
    | "fusion_plan_ready"
    | "fusion_approved"
    | "fusion_candidate_completed"
    | "fusion_candidate_interrupted"
    | "fusion_review_completed"
    | "fusion_integration_succeeded"
    | "fusion_integration_conflict"
    | "fusion_validation_failed"
    | "fusion_waiting_approval";
  createdAt: string;
  message: string;
  phase: FusionPhase;
  candidate?: FusionCandidate;
};

export type FusionPhaseSummaryRecord = {
  phase: FusionPhase;
  createdAt: string;
  participatingAgents: string[];
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  artifactIds: string[];
  nextPhase?: FusionPhase;
};

export type CampaignSpecRecord = {
  id: string;
  projectId: string;
  workerId: string;
  name: string;
  template: CampaignTemplate;
  task?: string;
  evaluationCommand?: string;
  experimentCommands: string[];
  experimentParallelism: number;
  iterations: number;
  steps: CampaignStepRecord[];
  acpSessionName?: string;
  currentStepIndex: number;
  currentRunId?: string;
  waitingApprovalStepId?: string;
  lastError?: string;
  lastProgressAt: string;
  createdAt: string;
  updatedAt: string;
  state: CampaignState;
  fusion?: FusionCampaignRecord;
};

export type RunRecord = {
  id: string;
  campaignId: string;
  projectId: string;
  workerId: string;
  stepId: string;
  stepTitle: string;
  stepIndex: number;
  kind: OrchestrationStepKind;
  executor: OrchestrationExecutor;
  state: RunState;
  startedAt: string;
  updatedAt: string;
  lastProgressAt: string;
  finishedAt?: string;
  summary?: string;
  outputText?: string;
  exitCode?: number;
  command?: string;
  sessionName?: string;
  attempts: number;
  failureCode?: string;
  failureCategory?: "timeout" | "execution" | "validation" | "unknown";
};

export type ArtifactFileRecord = {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
};

export type ArtifactRecord = {
  id: string;
  projectId: string;
  campaignId?: string;
  runId?: string;
  stepId?: string;
  siteId: string;
  kind:
    | "context"
    | "report"
    | "command-output"
    | "research-dossier"
    | "fusion-bundle"
    | "fusion-plan"
    | "fusion-plan-review"
    | "fusion-candidate"
    | "implementation-memo"
    | "peer-review"
    | "fusion-dossier"
    | "integration-report"
    | "merge-summary"
    | "candidate-diff"
    | "reassessment-plan"
    | "reassessment-report"
    | "reassessment-validation"
    | "reassessment-patch";
  title: string;
  summary?: string;
  relativePath: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  files?: ArtifactFileRecord[];
};

export type ArtifactReadResult = {
  artifact: ArtifactRecord;
  text: string;
  truncated: boolean;
  limitChars: number;
};

export type CampaignEventsResult = {
  campaignId: string;
  events: FusionEventRecord[];
  cursor?: string;
};

export type ImportedReassessmentSession = {
  id: string;
  provider: ReassessmentProvider;
  title: string;
  sourcePath?: string;
  projectRoot?: string;
  detectedModel?: string;
  createdAt?: string;
  updatedAt: string;
  transcriptHash: string;
  transcriptChars: number;
  transcriptPreview: string;
};

export type ReassessmentArtifactIds = {
  plan?: string;
  patch?: string;
  validation?: string;
  report?: string;
};

export type ReassessmentRecord = {
  id: string;
  projectId: string;
  workerId: string;
  state: ReassessmentState;
  targetModel: string;
  targetAgent: AgentKind;
  providers: ReassessmentProvider[];
  baseRef: string;
  baseCommit?: string;
  branch?: string;
  worktreePath?: string;
  validationCommand?: string;
  validationExitCode?: number;
  patchCommit?: string;
  importedSessions: ImportedReassessmentSession[];
  warnings: string[];
  artifactIds: ReassessmentArtifactIds;
  reportText?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type CampaignProgressSnapshot = {
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  currentStepIndex: number;
  experimentParallelism: number;
  currentStepId?: string;
  currentStepTitle?: string;
  currentRunId?: string;
  lastProgressAt: string;
};

export type CampaignStatusSnapshot = {
  campaign: CampaignSpecRecord;
  project: ProjectRecord | null;
  worker: WorkerRecord | null;
  runs: RunRecord[];
  artifacts: ArtifactRecord[];
  progress: CampaignProgressSnapshot;
};

export interface IOrchestrator {
  createProject(params: import("../shared/types.js").ProjectCreateParams): Promise<import("../shared/types.js").ToolResult>;
  registerWorker(params: import("../shared/types.js").WorkerManifestInput): Promise<import("../shared/types.js").ToolResult>;
  syncContext(params: import("../shared/types.js").ContextSyncParams): Promise<import("../shared/types.js").ToolResult>;
  runCampaign(params: import("../shared/types.js").CampaignRunParams): Promise<import("../shared/types.js").ToolResult>;
  status(params: import("../shared/types.js").CampaignStatusParams): Promise<import("../shared/types.js").ToolResult>;
  listArtifacts(params: import("../shared/types.js").ArtifactListParams): Promise<import("../shared/types.js").ToolResult>;
  readArtifact(params: import("../shared/types.js").ArtifactReadParams): Promise<import("../shared/types.js").ToolResult>;
  campaignEvents(params: import("../shared/types.js").CampaignEventsParams): Promise<import("../shared/types.js").ToolResult>;
  approve(params: import("../shared/types.js").CampaignActionParams): Promise<import("../shared/types.js").ToolResult>;
  cancel(params: import("../shared/types.js").CampaignActionParams): Promise<import("../shared/types.js").ToolResult>;
  startReassessment(params: import("../shared/types.js").ReassessmentStartParams): Promise<import("../shared/types.js").ToolResult>;
  reassessmentStatus(params: import("../shared/types.js").ReassessmentStatusParams): Promise<import("../shared/types.js").ToolResult>;
  reassessmentReport(params: import("../shared/types.js").ReassessmentReportParams): Promise<import("../shared/types.js").ToolResult>;
  siteStatus(params?: import("../shared/types.js").SiteStatusParams): Promise<import("../shared/types.js").ToolResult>;
  logs(params: import("../shared/types.js").LogsParams): Promise<import("../shared/types.js").ToolResult>;
}
