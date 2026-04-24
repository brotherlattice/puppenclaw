import type { z } from "zod";

import type {
  agentKindZod,
  backendZod,
  campaignActionParamsZod,
  campaignRunParamsZod,
  campaignStateZod,
  campaignStatusParamsZod,
  campaignTemplateZod,
  campaignStepParamsZod,
  contextSyncParamsZod,
  costParamsZod,
  effortLevelZod,
  exposeParamsZod,
  forkParamsZod,
  mcpServerConfigZod,
  orchestrationConfigZod,
  orchestrationExecutorZod,
  orchestrationStepKindZod,
  permissionModeZod,
  planningProfileZod,
  pluginConfigZod,
  projectCreateParamsZod,
  reassessmentProviderZod,
  reassessmentReportParamsZod,
  reassessmentStartParamsZod,
  reassessmentStateZod,
  reassessmentStatusParamsZod,
  remoteControlConfigZod,
  resumeParamsZod,
  runStateZod,
  artifactListParamsZod,
  exposureModeZod,
  logsParamsZod,
  remoteVerbZod,
  responseFormatZod,
  sendParamsZod,
  siteStatusParamsZod,
  startParamsZod,
  statusParamsZod,
  stopParamsZod,
  workerManifestZod
} from "./schema.js";

export type AgentKind = z.infer<typeof agentKindZod>;
export type BackendMode = z.infer<typeof backendZod>;
export type PermissionMode = z.infer<typeof permissionModeZod>;
export type EffortLevel = z.infer<typeof effortLevelZod>;
export type PlanningProfile = z.infer<typeof planningProfileZod>;
export type ResponseFormat = z.infer<typeof responseFormatZod>;
export type ExposureMode = z.infer<typeof exposureModeZod>;
export type RemoteVerb = z.infer<typeof remoteVerbZod>;
export type PluginConfig = z.input<typeof pluginConfigZod>;
export type ParsedPluginConfig = z.output<typeof pluginConfigZod>;
export type McpServerConfig = z.infer<typeof mcpServerConfigZod>;
export type RemoteControlConfig = z.infer<typeof remoteControlConfigZod>;
export type OrchestrationConfig = z.infer<typeof orchestrationConfigZod>;
export type StartParams = z.infer<typeof startParamsZod>;
export type SendParams = z.infer<typeof sendParamsZod>;
export type StopParams = z.infer<typeof stopParamsZod>;
export type ResumeParams = z.infer<typeof resumeParamsZod>;
export type ForkParams = z.infer<typeof forkParamsZod>;
export type StatusParams = z.infer<typeof statusParamsZod>;
export type CostParams = z.infer<typeof costParamsZod>;
export type ExposeParams = z.infer<typeof exposeParamsZod>;
export type WorkerManifestInput = z.infer<typeof workerManifestZod>;
export type ProjectCreateParams = z.infer<typeof projectCreateParamsZod>;
export type ContextSyncParams = z.infer<typeof contextSyncParamsZod>;
export type OrchestrationStepParams = z.infer<typeof campaignStepParamsZod>;
export type CampaignRunParams = z.infer<typeof campaignRunParamsZod>;
export type CampaignStatusParams = z.infer<typeof campaignStatusParamsZod>;
export type ArtifactListParams = z.infer<typeof artifactListParamsZod>;
export type CampaignActionParams = z.infer<typeof campaignActionParamsZod>;
export type SiteStatusParams = z.infer<typeof siteStatusParamsZod>;
export type LogsParams = z.infer<typeof logsParamsZod>;
export type OrchestrationStepKind = z.infer<typeof orchestrationStepKindZod>;
export type OrchestrationExecutor = z.infer<typeof orchestrationExecutorZod>;
export type CampaignTemplate = z.infer<typeof campaignTemplateZod>;
export type CampaignState = z.infer<typeof campaignStateZod>;
export type ReassessmentProvider = z.infer<typeof reassessmentProviderZod>;
export type ReassessmentState = z.infer<typeof reassessmentStateZod>;
export type ReassessmentStartParams = z.infer<typeof reassessmentStartParamsZod>;
export type ReassessmentStatusParams = z.infer<typeof reassessmentStatusParamsZod>;
export type ReassessmentReportParams = z.infer<typeof reassessmentReportParamsZod>;
export type RunState = z.infer<typeof runStateZod>;

export type ToolTextBlock = {
  type: "text";
  text: string;
};

export type ToolResult<TDetails = Record<string, unknown>> = {
  content: ToolTextBlock[];
  details: TDetails;
};

export type SessionState =
  | "idle"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "stopped";

export type TokenUsage = {
  used?: number;
  size?: number;
  input?: number;
  output?: number;
  cached?: number;
};

export type SessionTranscriptEntry = {
  role: "system" | "user" | "assistant" | "status";
  text: string;
  createdAt: string;
};

export type ContextFileEntry = {
  path: string;
  resolvedPath: string;
  bytes: number;
  truncated: boolean;
};

export type AcpxSessionHandle = {
  runtimeSessionName: string;
  cwd: string;
  agent: AgentKind;
  mode: "persistent";
};

export type SessionInfo = {
  name: string;
  agent: AgentKind;
  directory: string;
  state: SessionState;
  createdAt: string;
  lastActivity: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  planningProfile?: PlanningProfile;
  model?: string;
  tokenUsage?: TokenUsage;
  pendingQuestion?: string;
  lastError?: string;
  warnings: string[];
  transcript: SessionTranscriptEntry[];
  handle?: AcpxSessionHandle;
  lastStopReason?: string;
  source?: SessionSourceInfo;
  origin?: ConversationScope;
};

export type ConversationScope = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
};

export type SessionSourceInfo = {
  kind: "tool" | "command" | "daemon";
  channel?: string;
  requesterSenderId?: string;
  bindingId?: string;
};

export type ExposureRecord = {
  bindingId: string;
  conversation: ConversationScope;
  allowPurePipe: boolean;
  allowedAgents: AgentKind[];
  mode: ExposureMode;
  allowedVerbs: RemoteVerb[];
  allowedProjectRoots: string[];
  updatedAt: string;
};

export type SiteAgentAvailability = {
  agent: AgentKind;
  command: string;
  configured: boolean;
};

export type SiteSessionSnapshot = {
  name: string;
  agent: AgentKind;
  directory: string;
  state: SessionState;
  lastActivity: string;
  sourceKind?: SessionSourceInfo["kind"];
};

export type SiteCampaignSnapshot = {
  id: string;
  name: string;
  projectId: string;
  workerId: string;
  template: CampaignTemplate;
  state: CampaignState;
  currentStepIndex: number;
  experimentParallelism: number;
  lastProgressAt: string;
  lastError?: string;
};

export type SiteWorkerSnapshot = {
  id: string;
  label: string;
  labels: string[];
  projectRoots: string[];
  supportedSteps: OrchestrationStepKind[];
  executors: OrchestrationExecutor[];
  defaultAgent?: AgentKind;
  maxConcurrentRuns: number;
  activeCampaigns: number;
};

export type SiteStatus = {
  siteId: string;
  label: string;
  backend: BackendMode;
  pluginHealth: "ok";
  openclawRuntime: {
    available: boolean;
  };
  defaultAgent: AgentKind;
  availableAgents: SiteAgentAvailability[];
  orchestration: {
    enabled: boolean;
    allowLocalCommandExecution: boolean;
    defaultProjectRoot?: string;
    projectRoots: string[];
  };
  sessions: {
    maxSessions: number;
    total: number;
    active: number;
    streamOutputSupported: boolean;
    logTailingSupported: boolean;
    items?: SiteSessionSnapshot[];
  };
  campaigns: {
    maxCampaigns: number;
    total: number;
    active: number;
    items?: SiteCampaignSnapshot[];
  };
  workers: SiteWorkerSnapshot[];
  exposures: {
    total: number;
    currentExposure: ExposureRecord | null;
    items?: ExposureRecord[];
  };
};

export type LogScope = "session" | "campaign" | "run";

export type LogEntry = {
  id: string;
  title: string;
  state?: string;
  updatedAt: string;
  text: string;
};

export type LogsResult = {
  scope: LogScope;
  targetId: string;
  limitChars: number;
  followRequested: boolean;
  followSupported: boolean;
  text: string;
  entries: LogEntry[];
};

export type StoredState = {
  version: 1;
  sessions: Record<string, SessionInfo>;
  exposures: Record<string, ExposureRecord>;
};

export type PromptEvent =
  | {
      type: "text_delta";
      text: string;
      stream: "output" | "thought";
      tag?: string;
    }
  | {
      type: "tool_call";
      text: string;
      title: string;
      status?: string;
      tag?: string;
      toolCallId?: string;
    }
  | {
      type: "status";
      text: string;
      tag?: string;
      used?: number;
      size?: number;
    }
  | {
      type: "done";
      stopReason?: string;
    }
  | {
      type: "error";
      message: string;
      code?: string;
      retryable?: boolean;
    };

export type CommandParseResult =
  | {
      ok: true;
      verb: string;
      payloadText: string;
    }
  | {
      ok: false;
      message: string;
    };
