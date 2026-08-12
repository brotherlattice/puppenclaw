import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";

import type { ModelProviderConfig, SendParams, StartParams } from "./types.js";

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | CanonicalObject;
type CanonicalObject = { [key: string]: CanonicalValue };

function canonicalProvider(provider: ModelProviderConfig | undefined): CanonicalValue {
  if (provider == null) {
    return null;
  }
  return {
    id: provider.id,
    label: provider.label ?? null,
    kind: provider.kind ?? null,
    model: provider.model,
    reasoningProfile: provider.reasoningProfile ?? null,
    baseUrl: provider.baseUrl ?? null,
    authTokenEnv: provider.authTokenEnv ?? null,
    wireApi: provider.wireApi ?? null
  };
}

function stableJson(value: CanonicalValue): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key] ?? null)}`)
    .join(",")}}`;
}

function fingerprint(value: CanonicalObject): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function fingerprintStartRequest(params: StartParams): string {
  return fingerprint({
    version: 1,
    operation: "start",
    sessionName: params.name.trim(),
    agent: params.agent,
    directory: resolvePath(params.directory),
    task: params.task.trim(),
    permissionMode: params.permissionMode ?? null,
    interactionMode: params.interactionMode ?? null,
    effort: params.effort ?? null,
    planningProfile: params.planningProfile ?? null,
    model: params.model ?? null,
    modelProviderId: params.modelProviderId ?? null,
    modelProvider: canonicalProvider(params.modelProvider),
    contextFiles: (params.contextFiles ?? []).map((entry) => entry.trim()),
    skills: [...new Set((params.skills ?? []).map((entry) => entry.trim()))].sort()
  });
}

export function fingerprintSendRequest(params: SendParams): string {
  return fingerprint({
    version: 1,
    operation: "send",
    sessionName: params.name.trim(),
    message: params.message.trim(),
    ultrathink: params.ultrathink ?? false,
    effort: params.effort ?? null,
    permissionMode: params.permissionMode ?? null,
    interactionMode: params.interactionMode ?? null,
    modelProviderId: params.modelProviderId ?? null,
    modelProvider: canonicalProvider(params.modelProvider),
    contextFiles: (params.contextFiles ?? []).map((entry) => entry.trim())
  });
}
