import { resolve } from "node:path";

import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginConversationBinding
} from "openclaw/plugin-sdk/core";

import {
  artifactListParamsZod,
  campaignActionParamsZod,
  campaignRunParamsZod,
  campaignStatusParamsZod,
  contextSyncParamsZod,
  costParamsZod,
  exposeParamsZod,
  forkParamsZod,
  logsParamsZod,
  projectCreateParamsZod,
  resumeParamsZod,
  siteStatusParamsZod,
  sendParamsZod,
  startParamsZod,
  statusParamsZod,
  stopParamsZod,
  workerManifestZod
} from "../shared/schema.js";
import type {
  AgentKind,
  CommandParseResult,
  ConversationScope,
  ExposureRecord,
  RemoteVerb,
  SessionInfo
} from "../shared/types.js";
import { nowIso } from "../shared/utils.js";
import { isOc2ocRemoteChannel, toConversationScope } from "./config.js";
import { OutputRouter, type OutputRouteEvent } from "./output-router.js";
import {
  getConfiguredPluginConfig,
  getPuppenclawManager,
  getPuppenclawOrchestrator,
  getPuppenclawOrchestratorStore,
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

const READ_ONLY_VERBS = new Set<RemoteVerb>([
  "campaign-status",
  "artifacts",
  "site-status",
  "logs",
  "status",
  "cost"
]);

function renderCommandResult(
  result: { content: Array<{ text: string }>; details: unknown },
  format?: "text" | "json",
  streamedText?: string
): string {
  if (format === "json") {
    return JSON.stringify(result.details, null, 2);
  }
  return [streamedText?.trim(), flattenResultText(result)].filter(Boolean).join("\n\n");
}

function renderCommandError(error: unknown, format?: "text" | "json"): string {
  const message = error instanceof Error ? error.message : String(error);
  if (format === "json") {
    return JSON.stringify({ error: message }, null, 2);
  }
  return message;
}

function rootAllowed(exposure: ExposureRecord, projectRoot: string | null | undefined): boolean {
  if (projectRoot == null || exposure.allowedProjectRoots.length === 0) {
    return true;
  }
  const resolvedProjectRoot = resolve(projectRoot);
  return exposure.allowedProjectRoots.some((root) => resolvedProjectRoot.startsWith(resolve(root)));
}

function renderHelp(): string {
  return [
    "Usage: /puppenclaw <verb> [json]",
    "Verbs:",
    "start {\"agent\":\"codex\",\"name\":\"api-refactor\",\"directory\":\".\",\"task\":\"Implement the server side.\",\"planningProfile\":\"deep\"}",
    "send {\"name\":\"api-refactor\",\"message\":\"Continue and run tests.\",\"stream\":true}",
    "status {}",
    "stop {\"name\":\"api-refactor\"}",
    "resume {\"name\":\"api-refactor\"}",
    "fork {\"source\":\"api-refactor\",\"target\":\"api-refactor-alt\"}",
    "cost {\"name\":\"api-refactor\"}",
    "project {\"name\":\"ml-research\",\"rootDir\":\".\",\"description\":\"Main project root.\",\"defaultAgent\":\"codex\",\"fusionPreferredAgent\":\"codex\",\"planningProfile\":\"deep\"}",
    "worker {\"id\":\"local\",\"label\":\"Local Worker\",\"labels\":[\"gpu\"],\"projectRoots\":[\".\"]}",
    "sync {\"projectId\":\"ml-research\",\"includeFiles\":[\"AGENTS.md\",\"README.md\"]}",
    "campaign {\"projectId\":\"ml-research\",\"workerId\":\"local\",\"name\":\"fusion\",\"template\":\"puppenfusion\",\"task\":\"Implement the feature.\",\"fusionPreferredAgent\":\"codex\",\"evaluationCommand\":\"npm test\"}",
    "campaign-status {\"campaignId\":\"camp-...\"}",
    "artifacts {\"campaignId\":\"camp-...\"}",
    "approve {\"campaignId\":\"camp-...\"}",
    "cancel {\"campaignId\":\"camp-...\"}",
    "site-status {\"verbose\":true}",
    "logs {\"campaignId\":\"camp-...\",\"limitChars\":12000}",
    "bind",
    "unbind",
    "expose {\"agents\":[\"claude\",\"codex\"],\"allowPurePipe\":true,\"mode\":\"execute\",\"allowedVerbs\":[\"campaign\",\"campaign-status\",\"logs\"],\"allowedProjectRoots\":[\"/workspace\"]}",
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
  params: {
    verb: RemoteVerb;
    agent?: AgentKind | null;
    projectRoot?: string | null;
  }
): Promise<{
  binding: PluginConversationBinding;
  exposure: ExposureRecord;
}> {
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
  if (!exposure.allowedVerbs.includes(params.verb)) {
    throw new Error(`Pure-pipe control is not exposed for verb ${params.verb}.`);
  }
  if (!READ_ONLY_VERBS.has(params.verb) && exposure.mode !== "execute") {
    throw new Error(`Pure-pipe control is read-only for binding ${binding.bindingId}.`);
  }
  if (params.agent != null && !exposure.allowedAgents.includes(params.agent)) {
    throw new Error(`Pure-pipe control is not exposed for agent ${params.agent}.`);
  }
  if (!rootAllowed(exposure, params.projectRoot)) {
    throw new Error(`Pure-pipe control is not exposed for project root ${params.projectRoot}.`);
  }
  return { binding, exposure };
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

async function resolveProjectRoot(projectId: string): Promise<string> {
  const store = await getPuppenclawOrchestratorStore();
  const project = store.getProject(projectId);
  if (project == null) {
    throw new Error(`Unknown project ${projectId}.`);
  }
  return project.rootDir;
}

async function resolveCampaignProjectRoot(campaignId: string): Promise<string> {
  const store = await getPuppenclawOrchestratorStore();
  const campaign = store.getCampaign(campaignId);
  if (campaign == null) {
    throw new Error(`Unknown campaign ${campaignId}.`);
  }
  return resolveProjectRoot(campaign.projectId);
}

async function resolveRunProjectRoot(runId: string): Promise<string> {
  const store = await getPuppenclawOrchestratorStore();
  const run = store.getRun(runId);
  if (run == null) {
    throw new Error(`Unknown run ${runId}.`);
  }
  return resolveProjectRoot(run.projectId);
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
    mode: parsed.mode,
    allowedVerbs: [...parsed.allowedVerbs],
    allowedProjectRoots: parsed.allowedProjectRoots.map((entry) => resolve(entry)),
    updatedAt: nowIso()
  };
  const store = await getPuppenclawStore();
  await store.upsertExposure(exposure);
  return {
    text: `Exposed ${exposure.mode} pure-pipe control for ${exposure.allowedAgents.join(", ")} on binding ${binding.bindingId}.`
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
      let requestedFormat: "text" | "json" | undefined;
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
        const orchestrator = await getPuppenclawOrchestrator();
        const router = await getPuppenclawOutputRouter();
        const remote = sessionRequiresRemoteAuthorization(ctx);
        const config = getConfiguredPluginConfig();

        switch (parsed.verb) {
          case "project": {
            const params = projectCreateParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              await requirePurePipeExposure(ctx, {
                verb: "project",
                projectRoot: resolve(config.orchestration.defaultProjectRoot ?? process.cwd(), params.rootDir)
              });
            }
            const result = await orchestrator.createProject(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "worker": {
            const params = workerManifestZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              const { exposure } = await requirePurePipeExposure(ctx, { verb: "worker" });
              if (exposure.allowedProjectRoots.length > 0) {
                if (params.projectRoots.length === 0) {
                  throw new Error("Remote worker registration must declare projectRoots when project-root restrictions are active.");
                }
                for (const root of params.projectRoots) {
                  if (!rootAllowed(exposure, root)) {
                    throw new Error(`Remote worker registration is not allowed for project root ${root}.`);
                  }
                }
              }
            }
            const result = await orchestrator.registerWorker(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "sync": {
            const params = contextSyncParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              await requirePurePipeExposure(ctx, {
                verb: "sync",
                projectRoot: await resolveProjectRoot(params.projectId)
              });
            }
            const result = await orchestrator.syncContext(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "campaign": {
            const params = campaignRunParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              await requirePurePipeExposure(ctx, {
                verb: "campaign",
                projectRoot: await resolveProjectRoot(params.projectId)
              });
            }
            const result = await orchestrator.runCampaign(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "campaign-status": {
            const params = campaignStatusParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              const auth = await requirePurePipeExposure(ctx, {
                verb: "campaign-status",
                projectRoot:
                  params.campaignId != null
                    ? await resolveCampaignProjectRoot(params.campaignId)
                    : params.projectId != null
                      ? await resolveProjectRoot(params.projectId)
                      : null
              });
              if (
                params.campaignId == null &&
                params.projectId == null &&
                auth.exposure.allowedProjectRoots.length > 0
              ) {
                throw new Error("campaign-status requires campaignId or projectId when project-root restrictions are active.");
              }
            }
            const result = await orchestrator.status(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "artifacts": {
            const params = artifactListParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              const auth = await requirePurePipeExposure(ctx, {
                verb: "artifacts",
                projectRoot:
                  params.campaignId != null
                    ? await resolveCampaignProjectRoot(params.campaignId)
                    : params.projectId != null
                      ? await resolveProjectRoot(params.projectId)
                      : null
              });
              if (
                params.campaignId == null &&
                params.projectId == null &&
                auth.exposure.allowedProjectRoots.length > 0
              ) {
                throw new Error("artifacts requires campaignId or projectId when project-root restrictions are active.");
              }
            }
            const result = await orchestrator.listArtifacts(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "approve": {
            const params = campaignActionParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              await requirePurePipeExposure(ctx, {
                verb: "approve",
                projectRoot: await resolveCampaignProjectRoot(params.campaignId)
              });
            }
            const result = await orchestrator.approve(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "cancel": {
            const params = campaignActionParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              await requirePurePipeExposure(ctx, {
                verb: "cancel",
                projectRoot: await resolveCampaignProjectRoot(params.campaignId)
              });
            }
            const result = await orchestrator.cancel(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "site-status": {
            const params = siteStatusParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            const exposureResult = remote
              ? await requirePurePipeExposure(ctx, { verb: "site-status" })
              : null;
            const result = await orchestrator.siteStatus(params);
            if (exposureResult != null && result.details != null && typeof result.details === "object") {
              const details = result.details as {
                exposures?: {
                  currentExposure?: ExposureRecord | null;
                };
              };
              if (details.exposures != null) {
                details.exposures.currentExposure = exposureResult.exposure;
              }
            }
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "logs": {
            const params = logsParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              const projectRoot =
                params.sessionName != null
                  ? (await resolveSessionForRemoteVerb(params.sessionName)).directory
                  : params.campaignId != null
                    ? await resolveCampaignProjectRoot(params.campaignId)
                    : await resolveRunProjectRoot(params.runId as string);
              await requirePurePipeExposure(ctx, {
                verb: "logs",
                projectRoot
              });
            }
            const result = await orchestrator.logs(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "start": {
            const params = startParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            const binding = remote
              ? (
                  await requirePurePipeExposure(ctx, {
                    verb: "start",
                    agent: params.agent,
                    projectRoot: params.directory
                  })
                ).binding
              : await ctx.getCurrentConversationBinding();
            const { result, streamedText } = await withCommandOutputRoute(router, params.name, () =>
              manager.start(params)
            );
            if (binding != null) {
              await annotateCommandSession(binding, params.name);
            }
            return {
              text: renderCommandResult(result, requestedFormat, streamedText)
            };
          }
          case "send": {
            const params = sendParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              const session = await resolveSessionForRemoteVerb(params.name);
              await requirePurePipeExposure(ctx, {
                verb: "send",
                agent: session.agent,
                projectRoot: session.directory
              });
            }
            const { result, streamedText } = await withCommandOutputRoute(router, params.name, () =>
              manager.send(params)
            );
            return {
              text: renderCommandResult(result, requestedFormat, streamedText)
            };
          }
          case "status": {
            const params = statusParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote && params.name != null) {
              const session = await resolveSessionForRemoteVerb(params.name);
              await requirePurePipeExposure(ctx, {
                verb: "status",
                agent: session.agent,
                projectRoot: session.directory
              });
            } else if (remote) {
              const auth = await requirePurePipeExposure(ctx, { verb: "status" });
              if (auth.exposure.allowedProjectRoots.length > 0) {
                throw new Error("status requires a specific session name when project-root restrictions are active.");
              }
            }
            const result = await manager.status(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "stop": {
            const params = stopParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              const session = await resolveSessionForRemoteVerb(params.name);
              await requirePurePipeExposure(ctx, {
                verb: "stop",
                agent: session.agent,
                projectRoot: session.directory
              });
            }
            const result = await manager.stop(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "resume": {
            const params = resumeParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              const session = await resolveSessionForRemoteVerb(params.name);
              await requirePurePipeExposure(ctx, {
                verb: "resume",
                agent: session.agent,
                projectRoot: session.directory
              });
            }
            const result = await manager.resume(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "fork": {
            const params = forkParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            const binding = remote
              ? (
                  await requirePurePipeExposure(ctx, {
                    verb: "fork",
                    agent: (await resolveSessionForRemoteVerb(params.source)).agent,
                    projectRoot: (await resolveSessionForRemoteVerb(params.source)).directory
                  })
                ).binding
              : await ctx.getCurrentConversationBinding();
            const result = await manager.fork(params);
            if (binding != null) {
              await annotateCommandSession(binding, params.target);
            }
            return { text: renderCommandResult(result, requestedFormat) };
          }
          case "cost": {
            const params = costParamsZod.parse(parseJsonPayload(parsed.payloadText, {}));
            requestedFormat = params.format;
            if (remote) {
              const session = await resolveSessionForRemoteVerb(params.name);
              await requirePurePipeExposure(ctx, {
                verb: "cost",
                agent: session.agent,
                projectRoot: session.directory
              });
            }
            const result = await manager.cost(params);
            return { text: renderCommandResult(result, requestedFormat) };
          }
          default:
            return { text: renderHelp() };
        }
      } catch (error) {
        return {
          text: renderCommandError(error, requestedFormat)
        };
      }
    }
  });
}
