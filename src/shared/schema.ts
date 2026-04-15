import { z } from "zod";

import { Type } from "./typebox-lite.ts";

export const PACKAGE_NAME = "@puppenclaw/openclaw-plugin";
export const PLUGIN_ID = "puppenclaw";
export const PLUGIN_NAME = "Puppenclaw";
export const PLUGIN_DESCRIPTION =
  "Project-aware orchestration runtime for OpenClaw, with ACP coding agents, scientific campaign workflows, and oc2oc-aware remote control.";
export const DAEMON_PORT = 18_795;
export const DEFAULT_DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
export const DEFAULT_MAX_SESSIONS = 5;
export const DEFAULT_SESSION_TTL_MINUTES = 60;
export const DEFAULT_PERMISSION_MODE = "approve-reads" as const;
export const DEFAULT_AGENT = "claude" as const;
export const DEFAULT_REMOTE_REQUIRE_BINDING = true;
export const SESSION_STORE_VERSION = 1 as const;
export const DEFAULT_STREAM_OUTPUT = true;
export const DEFAULT_MAX_CAMPAIGNS = 32;
export const DEFAULT_ARTIFACT_RETENTION_HOURS = 24 * 14;
export const REMOTE_CONTROL_VERBS = [
  "project",
  "worker",
  "sync",
  "campaign",
  "campaign-status",
  "artifacts",
  "approve",
  "cancel",
  "site-status",
  "logs",
  "start",
  "send",
  "status",
  "stop",
  "resume",
  "fork",
  "cost"
] as const;
export const DEFAULT_ACPX_AGENT_COMMANDS = {
  claude: "npx -y @zed-industries/claude-agent-acp",
  codex: "npx @zed-industries/codex-acp"
} as const;

const nonEmptyString = z.string().trim().min(1);
const idString = nonEmptyString.regex(/^[a-zA-Z0-9._:-]+$/u);

export const agentKindZod = z.enum(["claude", "codex"]);
export const backendZod = z.enum(["local", "daemon"]);
export const permissionModeZod = z.enum(["approve-reads", "approve-all", "deny-all"]);
export const effortLevelZod = z.enum(["low", "medium", "high"]);
export const planningProfileZod = z.enum(["off", "quick", "deep"]);
export const responseFormatZod = z.enum(["text", "json"]);
export const exposureModeZod = z.enum(["read-only", "execute"]);
export const remoteVerbZod = z.enum(REMOTE_CONTROL_VERBS);
export const orchestrationStepKindZod = z.enum([
  "judge",
  "research",
  "plan",
  "code",
  "experiment",
  "eval",
  "artifact_sync",
  "review",
  "publish",
  "handoff"
]);
export const orchestrationExecutorZod = z.enum(["acp", "command"]);
export const campaignTemplateZod = z.enum([
  "custom",
  "literature_review",
  "baseline_from_scratch",
  "ablation_campaign",
  "self_improvement_loop"
]);
export const campaignStateZod = z.enum([
  "draft",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled"
]);
export const runStateZod = z.enum([
  "pending",
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled"
]);

export const mcpServerConfigZod = z
  .object({
    command: nonEmptyString.optional(),
    args: z.array(nonEmptyString).default([]),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    cwd: nonEmptyString.optional(),
    workingDirectory: nonEmptyString.optional(),
    url: nonEmptyString.optional()
  })
  .passthrough();

export const remoteControlConfigZod = z
  .object({
    mediated: z
      .object({
        enabled: z.boolean().default(true)
      })
      .strict()
      .default({ enabled: true }),
    purePipe: z
      .object({
        enabled: z.boolean().default(false),
        allowFrom: z.array(nonEmptyString).default([]),
        allowedAgents: z.array(agentKindZod).default([])
      })
      .strict()
      .default({
        enabled: false,
        allowFrom: [],
        allowedAgents: []
      }),
    requireConversationBinding: z.boolean().default(DEFAULT_REMOTE_REQUIRE_BINDING)
  })
  .strict()
  .default({
    mediated: { enabled: true },
    purePipe: {
      enabled: false,
      allowFrom: [],
      allowedAgents: []
    },
    requireConversationBinding: DEFAULT_REMOTE_REQUIRE_BINDING
  });

export const orchestrationConfigZod = z
  .object({
    enabled: z.boolean().default(true),
    maxCampaigns: z.number().int().min(1).max(500).default(DEFAULT_MAX_CAMPAIGNS),
    artifactRetentionHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .default(DEFAULT_ARTIFACT_RETENTION_HOURS),
    allowLocalCommandExecution: z.boolean().default(true),
    defaultProjectRoot: nonEmptyString.optional(),
    gptResearcherCommand: nonEmptyString.optional(),
    localWorker: z
      .object({
        id: idString.default("local"),
        label: nonEmptyString.default("Local Worker"),
        labels: z.array(nonEmptyString).default(["local"]),
        projectRoots: z.array(nonEmptyString).default([])
      })
      .strict()
      .default({
        id: "local",
        label: "Local Worker",
        labels: ["local"],
        projectRoots: []
      })
  })
  .strict()
  .default({
    enabled: true,
    maxCampaigns: DEFAULT_MAX_CAMPAIGNS,
    artifactRetentionHours: DEFAULT_ARTIFACT_RETENTION_HOURS,
    allowLocalCommandExecution: true,
    localWorker: {
      id: "local",
      label: "Local Worker",
      labels: ["local"],
      projectRoots: []
    }
  });

export const pluginConfigZod = z
  .object({
    backend: backendZod.default("local"),
    daemonUrl: nonEmptyString.default(DEFAULT_DAEMON_URL),
    defaultAgent: agentKindZod.default(DEFAULT_AGENT),
    maxSessions: z.number().int().min(1).max(100).default(DEFAULT_MAX_SESSIONS),
    permissionMode: permissionModeZod.default(DEFAULT_PERMISSION_MODE),
    sessionTtlMinutes: z.number().int().min(1).max(24 * 60).default(DEFAULT_SESSION_TTL_MINUTES),
    streamOutput: z.boolean().default(DEFAULT_STREAM_OUTPUT),
    acpxCommand: nonEmptyString.optional(),
    agentCommands: z
      .object({
        claude: nonEmptyString.optional(),
        codex: nonEmptyString.optional()
      })
      .strict()
      .default({}),
    mcpServers: z.record(z.string(), mcpServerConfigZod).default({}),
    fallbackTarget: nonEmptyString.optional(),
    remoteControl: remoteControlConfigZod,
    orchestration: orchestrationConfigZod
  })
  .strict();

export const workerManifestZod = z
  .object({
    id: idString,
    label: nonEmptyString,
    format: responseFormatZod.optional(),
    labels: z.array(nonEmptyString).default([]),
    projectRoots: z.array(nonEmptyString).default([]),
    supportedSteps: z.array(orchestrationStepKindZod).default([
      "judge",
      "research",
      "plan",
      "code",
      "experiment",
      "eval",
      "review",
      "publish",
      "handoff"
    ]),
    executors: z.array(orchestrationExecutorZod).default(["acp"]),
    defaultAgent: agentKindZod.optional(),
    maxConcurrentRuns: z.number().int().min(1).max(64).default(1),
    adminOnlyRawSessions: z.boolean().default(true)
  })
  .strict();

export const projectCreateParamsZod = z
  .object({
    id: idString.optional(),
    name: nonEmptyString,
    rootDir: nonEmptyString,
    description: z.string().trim().optional(),
    defaultAgent: agentKindZod.optional(),
    planningProfile: planningProfileZod.optional(),
    permissionMode: permissionModeZod.optional(),
    effort: effortLevelZod.optional(),
    model: nonEmptyString.optional(),
    format: responseFormatZod.optional()
  })
  .strict();

export const contextSyncParamsZod = z
  .object({
    projectId: idString,
    includeFiles: z.array(nonEmptyString).default([]),
    memoryText: z.string().trim().optional(),
    notes: z.string().trim().optional(),
    format: responseFormatZod.optional()
  })
  .strict();

export const campaignStepParamsZod = z
  .object({
    id: idString.optional(),
    title: nonEmptyString,
    kind: orchestrationStepKindZod,
    executor: orchestrationExecutorZod,
    instruction: z.string().trim().optional(),
    command: z.string().trim().optional(),
    contextFiles: z.array(nonEmptyString).default([]),
    approvalRequired: z.boolean().default(false),
    agent: agentKindZod.optional(),
    workingDirectory: nonEmptyString.optional(),
    env: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1000).optional(),
    retryLimit: z.number().int().min(0).max(8).default(0)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.executor === "acp" && (value.instruction?.trim().length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        message: "ACP orchestration steps require instruction text.",
        path: ["instruction"]
      });
    }
    if (value.executor === "command" && (value.command?.trim().length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        message: "Command orchestration steps require a command string.",
        path: ["command"]
      });
    }
  });

export const campaignRunParamsZod = z
  .object({
    projectId: idString,
    workerId: idString,
    name: nonEmptyString,
    format: responseFormatZod.optional(),
    template: campaignTemplateZod.default("custom"),
    task: nonEmptyString.optional(),
    evaluationCommand: z.string().trim().optional(),
    experimentCommands: z.array(nonEmptyString).default([]),
    experimentParallelism: z.number().int().min(1).max(16).default(1),
    iterations: z.number().int().min(1).max(10).default(1),
    steps: z.array(campaignStepParamsZod).default([])
  })
  .strict();

export const campaignStatusParamsZod = z
  .object({
    campaignId: idString.optional(),
    projectId: idString.optional(),
    format: responseFormatZod.optional()
  })
  .strict()
  .default({});

export const artifactListParamsZod = z
  .object({
    campaignId: idString.optional(),
    projectId: idString.optional(),
    format: responseFormatZod.optional()
  })
  .strict()
  .default({});

export const campaignActionParamsZod = z
  .object({
    campaignId: idString,
    format: responseFormatZod.optional()
  })
  .strict();

export const siteStatusParamsZod = z
  .object({
    verbose: z.boolean().default(false),
    format: responseFormatZod.optional()
  })
  .strict()
  .default({ verbose: false });

export const logsParamsZod = z
  .object({
    sessionName: nonEmptyString.optional(),
    campaignId: idString.optional(),
    runId: idString.optional(),
    limitChars: z.number().int().min(128).max(200_000).default(8_000),
    follow: z.boolean().default(false),
    format: responseFormatZod.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const populated = [value.sessionName, value.campaignId, value.runId].filter((entry) => entry != null);
    if (populated.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Exactly one of sessionName, campaignId, or runId is required.",
        path: ["sessionName"]
      });
    }
  });

export const startParamsZod = z
  .object({
    agent: agentKindZod,
    name: nonEmptyString,
    directory: nonEmptyString,
    task: nonEmptyString,
    format: responseFormatZod.optional(),
    permissionMode: permissionModeZod.optional(),
    effort: effortLevelZod.optional(),
    planningProfile: planningProfileZod.optional(),
    model: nonEmptyString.optional(),
    contextFiles: z.array(nonEmptyString).default([])
  })
  .strict();

export const sendParamsZod = z
  .object({
    name: nonEmptyString,
    message: nonEmptyString,
    format: responseFormatZod.optional(),
    stream: z.boolean().optional(),
    ultrathink: z.boolean().optional(),
    contextFiles: z.array(nonEmptyString).default([])
  })
  .strict();

export const stopParamsZod = z
  .object({
    name: nonEmptyString,
    format: responseFormatZod.optional()
  })
  .strict();

export const resumeParamsZod = z
  .object({
    name: nonEmptyString,
    format: responseFormatZod.optional()
  })
  .strict();

export const forkParamsZod = z
  .object({
    source: nonEmptyString,
    target: nonEmptyString,
    format: responseFormatZod.optional(),
    model: nonEmptyString.optional(),
    effort: effortLevelZod.optional()
  })
  .strict();

export const statusParamsZod = z
  .object({
    name: nonEmptyString.optional(),
    format: responseFormatZod.optional()
  })
  .strict()
  .default({});

export const costParamsZod = z
  .object({
    name: nonEmptyString,
    format: responseFormatZod.optional()
  })
  .strict();

export const exposeParamsZod = z
  .object({
    agents: z.array(agentKindZod).default([]),
    allowPurePipe: z.boolean().default(true),
    mode: exposureModeZod.default("execute"),
    allowedVerbs: z.array(remoteVerbZod).default([...REMOTE_CONTROL_VERBS]),
    allowedProjectRoots: z.array(nonEmptyString).default([])
  })
  .strict()
  .default({
    agents: [],
    allowPurePipe: true,
    mode: "execute",
    allowedVerbs: [...REMOTE_CONTROL_VERBS],
    allowedProjectRoots: []
  });

export const pluginManifestConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    backend: {
      type: "string",
      enum: ["local", "daemon"],
      description: "local uses acpx directly; daemon talks to a standalone HTTP daemon."
    },
    daemonUrl: {
      type: "string",
      description: "Only used when backend=daemon."
    },
    defaultAgent: {
      type: "string",
      enum: ["claude", "codex"],
      description: "Default ACP agent alias."
    },
    maxSessions: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Maximum concurrently tracked sessions."
    },
    permissionMode: {
      type: "string",
      enum: ["approve-reads", "approve-all", "deny-all"],
      description: "ACP permission policy."
    },
    sessionTtlMinutes: {
      type: "integer",
      minimum: 1,
      maximum: 1440,
      description: "Garbage-collect completed or stopped sessions after this TTL."
    },
    streamOutput: {
      type: "boolean",
      description: "Capture streamed output chunks while turns run."
    },
    acpxCommand: {
      type: "string",
      description: "Optional acpx binary override."
    },
    agentCommands: {
      type: "object",
      additionalProperties: false,
      properties: {
        claude: {
          type: "string",
          description: "Optional raw ACP adapter command override for Claude."
        },
        codex: {
          type: "string",
          description: "Optional raw ACP adapter command override for Codex."
        }
      }
    },
    mcpServers: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          command: {
            type: "string"
          },
          args: {
            type: "array",
            items: {
              type: "string"
            }
          },
          env: {
            type: "object",
            additionalProperties: {
              type: ["string", "number", "boolean"]
            }
          },
          cwd: {
            type: "string"
          },
          workingDirectory: {
            type: "string"
          },
          url: {
            type: "string"
          }
        }
      }
    },
    fallbackTarget: {
      type: "string",
      description: "Optional async notification target description."
    },
    orchestration: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean"
        },
        maxCampaigns: {
          type: "integer",
          minimum: 1,
          maximum: 500
        },
        artifactRetentionHours: {
          type: "integer",
          minimum: 1,
          maximum: 8760
        },
        allowLocalCommandExecution: {
          type: "boolean"
        },
        defaultProjectRoot: {
          type: "string"
        },
        gptResearcherCommand: {
          type: "string"
        },
        localWorker: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: {
              type: "string"
            },
            label: {
              type: "string"
            },
            labels: {
              type: "array",
              items: {
                type: "string"
              }
            },
            projectRoots: {
              type: "array",
              items: {
                type: "string"
              }
            }
          }
        }
      }
    },
    remoteControl: {
      type: "object",
      additionalProperties: false,
      properties: {
        mediated: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: {
              type: "boolean"
            }
          }
        },
        purePipe: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: {
              type: "boolean"
            },
            allowFrom: {
              type: "array",
              items: {
                type: "string"
              }
            },
            allowedAgents: {
              type: "array",
              items: {
                type: "string",
                enum: ["claude", "codex"]
              }
            }
          }
        },
        requireConversationBinding: {
          type: "boolean"
        }
      }
    }
  }
} as const;

export const toolStartSchema = Type.Object({
  agent: Type.Union([Type.Literal("claude"), Type.Literal("codex")]),
  name: Type.String({ minLength: 1 }),
  directory: Type.String({ minLength: 1 }),
  task: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  permissionMode: Type.Optional(
    Type.Union([
      Type.Literal("approve-reads"),
      Type.Literal("approve-all"),
      Type.Literal("deny-all")
    ])
  ),
  effort: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
  ),
  planningProfile: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("quick"), Type.Literal("deep")])
  ),
  model: Type.Optional(Type.String({ minLength: 1 })),
  contextFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
});

export const toolSendSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  stream: Type.Optional(Type.Boolean()),
  ultrathink: Type.Optional(Type.Boolean()),
  contextFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
});

export const toolStatusSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolStopSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolResumeSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolForkSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  target: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  model: Type.Optional(Type.String({ minLength: 1 })),
  effort: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
  )
});

export const toolCostSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolProjectCreateSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  name: Type.String({ minLength: 1 }),
  rootDir: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  defaultAgent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")])),
  planningProfile: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("quick"), Type.Literal("deep")])
  ),
  permissionMode: Type.Optional(
    Type.Union([
      Type.Literal("approve-reads"),
      Type.Literal("approve-all"),
      Type.Literal("deny-all")
    ])
  ),
  effort: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
  ),
  model: Type.Optional(Type.String({ minLength: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolWorkerRegisterSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  projectRoots: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  supportedSteps: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("judge"),
        Type.Literal("research"),
        Type.Literal("plan"),
        Type.Literal("code"),
        Type.Literal("experiment"),
        Type.Literal("eval"),
        Type.Literal("artifact_sync"),
        Type.Literal("review"),
        Type.Literal("publish"),
        Type.Literal("handoff")
      ])
    )
  ),
  executors: Type.Optional(
    Type.Array(Type.Union([Type.Literal("acp"), Type.Literal("command")]))
  ),
  defaultAgent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")])),
  maxConcurrentRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
  adminOnlyRawSessions: Type.Optional(Type.Boolean())
});

export const toolContextSyncSchema = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  includeFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  memoryText: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

const toolCampaignStepSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  title: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal("judge"),
    Type.Literal("research"),
    Type.Literal("plan"),
    Type.Literal("code"),
    Type.Literal("experiment"),
    Type.Literal("eval"),
    Type.Literal("artifact_sync"),
    Type.Literal("review"),
    Type.Literal("publish"),
    Type.Literal("handoff")
  ]),
  executor: Type.Union([Type.Literal("acp"), Type.Literal("command")]),
  instruction: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  contextFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  approvalRequired: Type.Optional(Type.Boolean()),
  agent: Type.Optional(Type.Union([Type.Literal("claude"), Type.Literal("codex")])),
  workingDirectory: Type.Optional(Type.String({ minLength: 1 })),
  env: Type.Optional(Type.Object({}, { additionalProperties: Type.String() })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 86400000 })),
  retryLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 }))
});

export const toolCampaignRunSchema = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  workerId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")])),
  template: Type.Optional(
    Type.Union([
      Type.Literal("custom"),
      Type.Literal("literature_review"),
      Type.Literal("baseline_from_scratch"),
      Type.Literal("ablation_campaign"),
      Type.Literal("self_improvement_loop")
    ])
  ),
  task: Type.Optional(Type.String({ minLength: 1 })),
  evaluationCommand: Type.Optional(Type.String()),
  experimentCommands: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  experimentParallelism: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
  iterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  steps: Type.Optional(Type.Array(toolCampaignStepSchema))
});

export const toolCampaignStatusSchema = Type.Object({
  campaignId: Type.Optional(Type.String({ minLength: 1 })),
  projectId: Type.Optional(Type.String({ minLength: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolArtifactsSchema = Type.Object({
  campaignId: Type.Optional(Type.String({ minLength: 1 })),
  projectId: Type.Optional(Type.String({ minLength: 1 })),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolCampaignActionSchema = Type.Object({
  campaignId: Type.String({ minLength: 1 }),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolSiteStatusSchema = Type.Object({
  verbose: Type.Optional(Type.Boolean()),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export const toolLogsSchema = Type.Object({
  sessionName: Type.Optional(Type.String({ minLength: 1 })),
  campaignId: Type.Optional(Type.String({ minLength: 1 })),
  runId: Type.Optional(Type.String({ minLength: 1 })),
  limitChars: Type.Optional(Type.Integer({ minimum: 128, maximum: 200000 })),
  follow: Type.Optional(Type.Boolean()),
  format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")]))
});

export function buildPluginManifest(): Record<string, unknown> {
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    skills: ["./skills"],
    configSchema: pluginManifestConfigSchema
  };
}
