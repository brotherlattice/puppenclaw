import { z } from "zod";

import { Type } from "./typebox-lite.ts";

export const PACKAGE_NAME = "@puppenclaw/openclaw-plugin";
export const PLUGIN_ID = "puppenclaw";
export const PLUGIN_NAME = "Puppenclaw";
export const PLUGIN_DESCRIPTION =
  "ACP-backed Claude Code and Codex orchestration for OpenClaw, with oc2oc-aware remote control.";
export const DAEMON_PORT = 18_795;
export const DEFAULT_DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
export const DEFAULT_MAX_SESSIONS = 5;
export const DEFAULT_SESSION_TTL_MINUTES = 60;
export const DEFAULT_PERMISSION_MODE = "approve-reads" as const;
export const DEFAULT_AGENT = "claude" as const;
export const DEFAULT_REMOTE_REQUIRE_BINDING = true;
export const SESSION_STORE_VERSION = 1 as const;
export const DEFAULT_STREAM_OUTPUT = true;
export const DEFAULT_ACPX_AGENT_COMMANDS = {
  claude: "npx -y @zed-industries/claude-agent-acp",
  codex: "npx @zed-industries/codex-acp"
} as const;

const nonEmptyString = z.string().trim().min(1);

export const agentKindZod = z.enum(["claude", "codex"]);
export const backendZod = z.enum(["local", "daemon"]);
export const permissionModeZod = z.enum(["approve-reads", "approve-all", "deny-all"]);
export const effortLevelZod = z.enum(["low", "medium", "high"]);

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
    remoteControl: remoteControlConfigZod
  })
  .strict();

export const startParamsZod = z
  .object({
    agent: agentKindZod,
    name: nonEmptyString,
    directory: nonEmptyString,
    task: nonEmptyString,
    permissionMode: permissionModeZod.optional(),
    effort: effortLevelZod.optional(),
    model: nonEmptyString.optional(),
    contextFiles: z.array(nonEmptyString).default([])
  })
  .strict();

export const sendParamsZod = z
  .object({
    name: nonEmptyString,
    message: nonEmptyString,
    stream: z.boolean().optional(),
    ultrathink: z.boolean().optional(),
    contextFiles: z.array(nonEmptyString).default([])
  })
  .strict();

export const stopParamsZod = z
  .object({
    name: nonEmptyString
  })
  .strict();

export const resumeParamsZod = z
  .object({
    name: nonEmptyString
  })
  .strict();

export const forkParamsZod = z
  .object({
    source: nonEmptyString,
    target: nonEmptyString,
    model: nonEmptyString.optional(),
    effort: effortLevelZod.optional()
  })
  .strict();

export const statusParamsZod = z
  .object({
    name: nonEmptyString.optional()
  })
  .strict()
  .default({});

export const costParamsZod = z
  .object({
    name: nonEmptyString
  })
  .strict();

export const exposeParamsZod = z
  .object({
    agents: z.array(agentKindZod).default([]),
    allowPurePipe: z.boolean().default(true)
  })
  .strict()
  .default({
    agents: [],
    allowPurePipe: true
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
  contextFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
});

export const toolSendSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
  stream: Type.Optional(Type.Boolean()),
  ultrathink: Type.Optional(Type.Boolean()),
  contextFiles: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
});

export const toolStatusSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 }))
});

export const toolStopSchema = Type.Object({
  name: Type.String({ minLength: 1 })
});

export const toolResumeSchema = Type.Object({
  name: Type.String({ minLength: 1 })
});

export const toolForkSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  target: Type.String({ minLength: 1 }),
  model: Type.Optional(Type.String({ minLength: 1 })),
  effort: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
  )
});

export const toolCostSchema = Type.Object({
  name: Type.String({ minLength: 1 })
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
