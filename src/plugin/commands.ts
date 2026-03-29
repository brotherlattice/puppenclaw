import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginConversationBinding
} from "openclaw/plugin-sdk/core";

import {
  costParamsZod,
  exposeParamsZod,
  forkParamsZod,
  resumeParamsZod,
  sendParamsZod,
  startParamsZod,
  statusParamsZod,
  stopParamsZod
} from "../shared/schema.js";
import type {
  AgentKind,
  CommandParseResult,
  ConversationScope,
  ExposureRecord,
  SessionInfo
} from "../shared/types.js";
import { nowIso } from "../shared/utils.js";
import { isOc2ocRemoteChannel, toConversationScope } from "./config.js";
import { OutputRouter, type OutputRouteEvent } from "./output-router.js";
import {
  getConfiguredPluginConfig,
  getPuppenclawManager,
  getPuppenclawOutputRouter,
  getPuppenclawStore,
  patchStoredSession
} from "./service.js";
import { summarizeToolResultText } from "./tools.js";

function parseCommandArgs(args: string | undefined): CommandParseResult {
  const raw = args?.trim() ?? "";
  if (!raw) {
    return {
      ok: false,
      message: renderHelp()
    };
  }
  const spaceIndex = raw.indexOf(" ");
  if (spaceIndex < 0) {
    return {
      ok: true,
      verb: raw.toLowerCase(),
      payloadText: ""
    };
  }
  return {
    ok: true,
    verb: raw.slice(0, spaceIndex).toLowerCase(),
    payloadText: raw.slice(spaceIndex + 1).trim()
  };
}

function parseJsonPayload<T>(payloadText: string, fallback: T): T {
  if (!payloadText.trim()) {
    return fallback;
  }
  return JSON.parse(payloadText) as T;
}

function flattenResultText(result: { content: Array<{ text: string }> }): string {
  return summarizeToolResultText(result);
}

function renderHelp(): string {
  return [
    "Usage: /puppenclaw <verb> [json]",
    "Verbs:",
    "start {\"agent\":\"codex\",\"name\":\"api-refactor\",\"directory\":\".\",\"task\":\"Implement the server side.\"}",
    "send {\"name\":\"api-refactor\",\"message\":\"Continue and run tests.\",\"stream\":true}",
    "status {}",
    "stop {\"name\":\"api-refactor\"}",
    "resume {\"name\":\"api-refactor\"}",
    "fork {\"source\":\"api-refactor\",\"target\":\"api-refactor-alt\"}",
    "cost {\"name\":\"api-refactor\"}",
    "bind",
    "unbind",
    "expose {\"agents\":[\"claude\",\"codex\"],\"allowPurePipe\":true}",
    "hide"
  ].join("\n");
}

class CommandStreamCollector {
  private readonly chunks: string[] = [];

  async onEvent(event: OutputRouteEvent): Promise<void> {
    switch (event.kind) {
      case "chunk":
        this.chunks.push(event.text);
        break;
      case "question":
        this.chunks.push(`\n[waiting-input]\n${event.text}\n`);
        break;
      case "error":
        this.chunks.push(`\n[error]\n${event.text}\n`);
        break;
      case "complete":
        break;
    }
  }

  render(): string {
    return this.chunks.join("").trim();
  }
}

async function withCommandOutputRoute<T extends { content: Array<{ text: string }> }>(
  router: OutputRouter,
  sessionName: string,
  run: () => Promise<T>
): Promise<{
  result: T;
  streamedText: string;
}> {
  const collector = new CommandStreamCollector();
  router.attach(sessionName, (event) => collector.onEvent(event));
  try {
    const result = await run();
    return {
      result,
      streamedText: collector.render()
    };
  } finally {
    router.detach(sessionName);
  }
}

function describeBinding(binding: PluginConversationBinding | null): string {
  if (binding == null) {
    return "No active Puppenclaw binding.";
  }
  return `Bound to ${binding.channel}:${binding.conversationId} as ${binding.bindingId}.`;
}

function exposureAgentsOrAll(agents: AgentKind[]): AgentKind[] {
  return agents.length > 0 ? agents : ["claude", "codex"];
}

function bindingToScope(binding: PluginConversationBinding): ConversationScope {
  return toConversationScope({
    channel: binding.channel,
    conversationId: binding.conversationId,
    ...(binding.accountId != null ? { accountId: binding.accountId } : {}),
    ...(binding.parentConversationId != null
      ? { parentConversationId: binding.parentConversationId }
      : {}),
    ...(binding.threadId != null ? { threadId: binding.threadId } : {})
  });
}

function sessionRequiresRemoteAuthorization(ctx: PluginCommandContext): boolean {
  return isOc2ocRemoteChannel(ctx.channel) || isOc2ocRemoteChannel(ctx.channelId);
}

async function requireBinding(ctx: PluginCommandContext): Promise<PluginConversationBinding> {
  const binding = await ctx.getCurrentConversationBinding();
  if (binding == null) {
    throw new Error("Pure-pipe remote control requires a Puppenclaw conversation binding. Run /puppenclaw bind first.");
  }
  return binding;
}

async function requirePurePipeExposure(
  ctx: PluginCommandContext,
  agent: AgentKind | null
): Promise<PluginConversationBinding> {
  const config = getConfiguredPluginConfig();
  if (!config.remoteControl.purePipe.enabled) {
    throw new Error("Pure-pipe remote control is disabled in Puppenclaw config.");
  }
  const binding = await requireBinding(ctx);
  const store = await getPuppenclawStore();
  const exposure = store.getExposure(binding.bindingId);
  if (exposure == null || !exposure.allowPurePipe) {
    throw new Error(
      "This remote conversation has not been exposed for deterministic Puppenclaw control."
    );
  }
  if (agent != null && !exposure.allowedAgents.includes(agent)) {
    throw new Error(`Pure-pipe control is not exposed for agent ${agent}.`);
  }
  return binding;
}

async function annotateCommandSession(binding: PluginConversationBinding, name: string): Promise<void> {
  await patchStoredSession(name, (session) => {
    if (session == null) {
      return session;
    }
    return {
      ...session,
      source: {
        kind: "command",
        channel: binding.channel,
        bindingId: binding.bindingId
      },
      origin: bindingToScope(binding)
    };
  });
}

async function resolveSessionForRemoteVerb(name: string): Promise<SessionInfo> {
  const store = await getPuppenclawStore();
  const session = store.getSession(name);
  if (session == null) {
    throw new Error(`Unknown session ${name}.`);
  }
  return session;
}

async function handleBindingCommand(ctx: PluginCommandContext): Promise<{ text: string }> {
  const current = await ctx.getCurrentConversationBinding();
  if (current != null) {
    return { text: describeBinding(current) };
  }
  const requested = await ctx.requestConversationBinding({
    summary: "Allow this conversation to remotely control Puppenclaw sessions.",
    detachHint: "/puppenclaw unbind"
  });
  if (requested.status === "bound") {
    return { text: describeBinding(requested.binding) };
  }
  if (requested.status === "pending") {
    return requested.reply;
  }
  return { text: requested.message };
}

async function handleExposeCommand(ctx: PluginCommandContext, payloadText: string): Promise<{ text: string }> {
  if (!getConfiguredPluginConfig().remoteControl.purePipe.enabled) {
    throw new Error("Pure-pipe remote control is disabled in Puppenclaw config.");
  }
  const binding = await requireBinding(ctx);
  const parsed = exposeParamsZod.parse(parseJsonPayload(payloadText, {}));
  const exposure: ExposureRecord = {
    bindingId: binding.bindingId,
    conversation: bindingToScope(binding),
    allowPurePipe: parsed.allowPurePipe,
    allowedAgents: exposureAgentsOrAll(parsed.agents),
    updatedAt: nowIso()
  };
  const store = await getPuppenclawStore();
  await store.upsertExposure(exposure);
  return {
    text: `Exposed pure-pipe control for ${exposure.allowedAgents.join(", ")} on binding ${binding.bindingId}.`
  };
}

async function handleHideCommand(ctx: PluginCommandContext): Promise<{ text: string }> {
  const binding = await requireBinding(ctx);
  const store = await getPuppenclawStore();
  const removed = await store.removeExposure(binding.bindingId);
  return {
    text: removed
      ? `Removed pure-pipe exposure for ${binding.bindingId}.`
      : `No pure-pipe exposure was set for ${binding.bindingId}.`
  };
}

async function handleUnbindCommand(ctx: PluginCommandContext): Promise<{ text: string }> {
  const binding = await ctx.getCurrentConversationBinding();
  if (binding != null) {
    const store = await getPuppenclawStore();
    await store.removeExposure(binding.bindingId);
  }
  const detached = await ctx.detachConversationBinding();
  return {
    text: detached.removed ? "Detached Puppenclaw binding." : "No Puppenclaw binding was active."
  };
}

export function registerPuppenclawCommands(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "puppenclaw",
    description: "Manage Puppenclaw ACP sessions and remote bindings.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: PluginCommandContext) => {
      try {
        const parsed = parseCommandArgs(ctx.args);
        if (!parsed.ok) {
          return { text: parsed.message };
        }

        if (parsed.verb === "bind") {
          return handleBindingCommand(ctx);
        }
        if (parsed.verb === "expose") {
          return handleExposeCommand(ctx, parsed.payloadText);
        }
        if (parsed.verb === "hide") {
          return handleHideCommand(ctx);
        }
        if (parsed.verb === "unbind") {
          return handleUnbindCommand(ctx);
        }

        const manager = await getPuppenclawManager();
        const router = await getPuppenclawOutputRouter();
        const remote = sessionRequiresRemoteAuthorization(ctx);

        switch (parsed.verb) {
          case "start": {
            const params = startParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            const binding = remote ? await requirePurePipeExposure(ctx, params.agent) : await ctx.getCurrentConversationBinding();
            const { result, streamedText } = await withCommandOutputRoute(router, params.name, () =>
              manager.start(params)
            );
            if (binding != null) {
              await annotateCommandSession(binding, params.name);
            }
            return {
              text: [streamedText, flattenResultText(result)].filter(Boolean).join("\n\n")
            };
          }
          case "send": {
            const params = sendParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            if (remote) {
              const session = await resolveSessionForRemoteVerb(params.name);
              await requirePurePipeExposure(ctx, session.agent);
            }
            const { result, streamedText } = await withCommandOutputRoute(router, params.name, () =>
              manager.send(params)
            );
            return {
              text: [streamedText, flattenResultText(result)].filter(Boolean).join("\n\n")
            };
          }
          case "status": {
            const params = statusParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            if (remote && params.name != null) {
              const session = await resolveSessionForRemoteVerb(params.name);
              await requirePurePipeExposure(ctx, session.agent);
            } else if (remote) {
              await requirePurePipeExposure(ctx, null);
            }
            const result = await manager.status(params);
            return { text: flattenResultText(result) };
          }
          case "stop": {
            const params = stopParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            if (remote) {
              const session = await resolveSessionForRemoteVerb(params.name);
              await requirePurePipeExposure(ctx, session.agent);
            }
            const result = await manager.stop(params);
            return { text: flattenResultText(result) };
          }
          case "resume": {
            const params = resumeParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            if (remote) {
              const session = await resolveSessionForRemoteVerb(params.name);
              await requirePurePipeExposure(ctx, session.agent);
            }
            const result = await manager.resume(params);
            return { text: flattenResultText(result) };
          }
          case "fork": {
            const params = forkParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            const binding = remote
              ? await requirePurePipeExposure(
                  ctx,
                  (await resolveSessionForRemoteVerb(params.source)).agent
                )
              : await ctx.getCurrentConversationBinding();
            const result = await manager.fork(params);
            if (binding != null) {
              await annotateCommandSession(binding, params.target);
            }
            return { text: flattenResultText(result) };
          }
          case "cost": {
            const params = costParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            if (remote) {
              const session = await resolveSessionForRemoteVerb(params.name);
              await requirePurePipeExposure(ctx, session.agent);
            }
            const result = await manager.cost(params);
            return { text: flattenResultText(result) };
          }
          default:
            return { text: renderHelp() };
        }
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error)
        };
      }
    }
  });
}
