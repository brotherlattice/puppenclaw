import { join, resolve } from "node:path";

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";

import { PLUGIN_ID, pluginConfigZod } from "../shared/schema.js";
import type { ConversationScope, ParsedPluginConfig } from "../shared/types.js";

export function readPluginConfig(raw: unknown): ParsedPluginConfig {
  return pluginConfigZod.parse(raw ?? {});
}

export function resolvePluginDataDir(params: {
  stateDir: string;
  pluginId?: string;
  resolvePath?: (input: string) => string;
}): string {
  const pluginId = params.pluginId ?? PLUGIN_ID;
  return params.resolvePath != null ? params.resolvePath(pluginId) : join(params.stateDir, pluginId);
}

export function resolveRuntimeSessionDir(dataDir: string): string {
  return join(dataDir, "sessions");
}

export function resolveDaemonDataDir(dataDir: string): string {
  return join(dataDir, "daemon");
}

export function resolveMaybeAbsolutePath(baseDir: string, input: string): string {
  return resolve(baseDir, input);
}

export function isOc2ocRemoteChannel(channel: string | undefined): boolean {
  return (channel ?? "").trim().toLowerCase() === "oc2oc";
}

export function toConversationScope(binding: {
  channel: string;
  accountId?: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
}): ConversationScope {
  return {
    channel: binding.channel,
    accountId: binding.accountId ?? DEFAULT_ACCOUNT_ID,
    conversationId: binding.conversationId,
    ...(binding.parentConversationId != null
      ? { parentConversationId: binding.parentConversationId }
      : {}),
    ...(binding.threadId != null ? { threadId: binding.threadId } : {})
  };
}
