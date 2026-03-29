import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext
} from "openclaw/plugin-sdk/core";

import {
  costParamsZod,
  forkParamsZod,
  resumeParamsZod,
  sendParamsZod,
  startParamsZod,
  statusParamsZod,
  stopParamsZod,
  toolCostSchema,
  toolForkSchema,
  toolResumeSchema,
  toolSendSchema,
  toolStartSchema,
  toolStatusSchema,
  toolStopSchema
} from "../shared/schema.js";
import { patchStoredSession, getPuppenclawManager } from "./service.js";

function flattenToolText(result: { content: Array<{ text: string }> }): string {
  return result.content.map((entry) => entry.text).join("\n").trim();
}

function annotateToolSessionSource(toolCtx: OpenClawPluginToolContext, name: string): Promise<void> {
  return patchStoredSession(name, (session) => {
    if (session == null) {
      return session;
    }
    return {
      ...session,
      source: {
        kind: "tool",
        ...(toolCtx.messageChannel != null ? { channel: toolCtx.messageChannel } : {}),
        ...(toolCtx.requesterSenderId != null
          ? { requesterSenderId: toolCtx.requesterSenderId }
          : {})
      }
    };
  }).then(() => undefined);
}

function createTools(toolCtx: OpenClawPluginToolContext): AnyAgentTool[] {
  return [
    {
      name: "puppenclaw_start",
      label: "Start Puppenclaw session",
      description: "Start or reuse a managed ACP session for Claude Code or Codex.",
      parameters: toolStartSchema,
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const manager = await getPuppenclawManager();
        const params = startParamsZod.parse(rawParams);
        const result = await manager.start(params);
        await annotateToolSessionSource(toolCtx, params.name);
        return {
          content: result.content,
          details: result.details
        };
      }
    },
    {
      name: "puppenclaw_send",
      label: "Send Puppenclaw message",
      description: "Send another message into an existing Puppenclaw-managed session.",
      parameters: toolSendSchema,
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const manager = await getPuppenclawManager();
        const params = sendParamsZod.parse(rawParams);
        const result = await manager.send(params);
        return {
          content: result.content,
          details: result.details
        };
      }
    },
    {
      name: "puppenclaw_status",
      label: "Puppenclaw status",
      description: "Inspect one managed session or list all managed sessions.",
      parameters: toolStatusSchema,
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const manager = await getPuppenclawManager();
        const result = await manager.status(statusParamsZod.parse(rawParams ?? {}));
        return {
          content: result.content,
          details: result.details
        };
      }
    },
    {
      name: "puppenclaw_stop",
      label: "Stop Puppenclaw session",
      description: "Stop an active Puppenclaw-managed session.",
      parameters: toolStopSchema,
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const manager = await getPuppenclawManager();
        const result = await manager.stop(stopParamsZod.parse(rawParams));
        return {
          content: result.content,
          details: result.details
        };
      }
    },
    {
      name: "puppenclaw_resume",
      label: "Resume Puppenclaw session",
      description: "Mark a stopped session as resumable again.",
      parameters: toolResumeSchema,
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const manager = await getPuppenclawManager();
        const result = await manager.resume(resumeParamsZod.parse(rawParams));
        return {
          content: result.content,
          details: result.details
        };
      }
    },
    {
      name: "puppenclaw_fork",
      label: "Fork Puppenclaw session",
      description: "Create a new session from the transcript of an existing session.",
      parameters: toolForkSchema,
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const manager = await getPuppenclawManager();
        const result = await manager.fork(forkParamsZod.parse(rawParams));
        return {
          content: result.content,
          details: result.details
        };
      }
    },
    {
      name: "puppenclaw_cost",
      label: "Puppenclaw usage",
      description: "Return recorded usage counters for a managed session.",
      parameters: toolCostSchema,
      execute: async (_toolCallId: string, rawParams: unknown) => {
        const manager = await getPuppenclawManager();
        const result = await manager.cost(costParamsZod.parse(rawParams));
        return {
          content: result.content,
          details: result.details
        };
      }
    }
  ].map((tool) => ({
    ...tool,
    displaySummary: tool.name
  }));
}

export function registerPuppenclawTools(api: OpenClawPluginApi): void {
  api.registerTool((toolCtx: OpenClawPluginToolContext) => createTools(toolCtx));
}

export function summarizeToolResultText(result: { content: Array<{ text: string }> }): string {
  return flattenToolText(result);
}
