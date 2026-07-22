import { describe, expect, it } from "vitest";

import {
  buildPluginManifest,
  pluginConfigZod,
  pluginSendParamsZod,
  pluginStartParamsZod,
  projectCreateParamsZod,
  reassessmentStartParamsZod,
  REMOTE_CONTROL_VERBS,
  sendParamsZod,
  startParamsZod,
  toolProjectCreateSchema,
  toolSendSchema,
  toolStartSchema
} from "../../src/shared/schema.js";

describe("plugin manifest and config schema", () => {
  it("emits orchestration config in the generated manifest", () => {
    const manifest = buildPluginManifest() as {
      description: string;
      configSchema: {
        properties: Record<string, unknown>;
      };
    };
    expect(manifest.description).toContain("Project-aware orchestration runtime");
    expect(manifest.configSchema.properties).toHaveProperty("orchestration");
  });

  it("fills orchestration defaults in parsed plugin config", () => {
    const parsed = pluginConfigZod.parse({});
    expect(parsed.orchestration.enabled).toBe(true);
    expect(parsed.orchestration.localWorker.id).toBe("local");
    expect(parsed.orchestration.allowLocalCommandExecution).toBe(true);
  });

  it("parses reassessment defaults and exposes remote verbs", () => {
    const parsed = reassessmentStartParamsZod.parse({
      projectId: "demo",
      workerId: "local",
      targetModel: "new-model"
    });
    expect(parsed.providers).toEqual(["puppenclaw", "codex", "claude"]);
    expect(parsed.limit).toBe(20);
    expect(REMOTE_CONTROL_VERBS).toContain("reassess");
    expect(REMOTE_CONTROL_VERBS).toContain("reassess-status");
    expect(REMOTE_CONTROL_VERBS).toContain("reassess-report");
    expect(REMOTE_CONTROL_VERBS).toContain("artifact-read");
    expect(REMOTE_CONTROL_VERBS).toContain("campaign-events");
  });

  it("keeps one-turn permission modes on the internal send boundary", () => {
    expect(
      sendParamsZod.parse({
        name: "demo",
        message: "Run the approved turn.",
        permissionMode: "approve-all"
      }).permissionMode
    ).toBe("approve-all");
    expect(
      sendParamsZod.safeParse({
        name: "demo",
        message: "Run the approved turn.",
        permissionMode: "unrestricted"
      }).success
    ).toBe(false);
    expect(
      pluginSendParamsZod.safeParse({
        name: "demo",
        message: "Try to elevate from the plugin.",
        permissionMode: "approve-all"
      }).success
    ).toBe(false);
    const toolProperties = (
      toolSendSchema as unknown as { properties: Record<string, unknown> }
    ).properties;
    expect(toolProperties).not.toHaveProperty("permissionMode");
    expect(
      sendParamsZod.parse({
        name: "demo",
        message: "Prepare a plan.",
        interactionMode: "plan"
      }).interactionMode
    ).toBe("plan");
    expect(
      pluginSendParamsZod.safeParse({
        name: "demo",
        message: "Try to choose an internal mode.",
        interactionMode: "execute"
      }).success
    ).toBe(false);
    expect(
      pluginStartParamsZod.safeParse({
        agent: "claude",
        name: "demo",
        directory: "/tmp/demo",
        task: "Try to choose an internal mode.",
        interactionMode: "plan"
      }).success
    ).toBe(false);
    expect(toolProperties).not.toHaveProperty("interactionMode");
    const startToolProperties = (
      toolStartSchema as unknown as { properties: Record<string, unknown> }
    ).properties;
    expect(startToolProperties).not.toHaveProperty("interactionMode");
    expect(startToolProperties).not.toHaveProperty("permissionMode");
    expect(
      pluginStartParamsZod.safeParse({
        agent: "claude",
        name: "demo",
        directory: "/tmp/demo",
        task: "Try to choose a permission baseline.",
        permissionMode: "approve-all"
      }).success
    ).toBe(false);
  });

  it("keeps lifecycle epochs on the authenticated daemon boundary", () => {
    expect(
      startParamsZod.parse({
        agent: "claude",
        name: "fenced-start",
        directory: "/tmp/fenced-start",
        task: "Resume the current lifecycle.",
        lifecycleEpoch: 7
      }).lifecycleEpoch
    ).toBe(7);
    expect(
      sendParamsZod.parse({
        name: "fenced-send",
        message: "Continue the current lifecycle.",
        lifecycleEpoch: 8
      }).lifecycleEpoch
    ).toBe(8);
    expect(
      pluginStartParamsZod.safeParse({
        agent: "claude",
        name: "fenced-start",
        directory: "/tmp/fenced-start",
        task: "Try to supply an internal lifecycle epoch.",
        lifecycleEpoch: 7
      }).success
    ).toBe(false);
    expect(
      pluginSendParamsZod.safeParse({
        name: "fenced-send",
        message: "Try to supply an internal lifecycle epoch.",
        lifecycleEpoch: 8
      }).success
    ).toBe(false);
    expect(
      (toolStartSchema as unknown as { properties: Record<string, unknown> }).properties
    ).not.toHaveProperty("lifecycleEpoch");
    expect(
      (toolSendSchema as unknown as { properties: Record<string, unknown> }).properties
    ).not.toHaveProperty("lifecycleEpoch");
  });

  it("keeps follow-up model-provider refresh on the authenticated daemon boundary", () => {
    const refresh = {
      modelProviderId: "local-glm",
      modelProvider: {
        id: "local-glm",
        kind: "codex-openai-compatible" as const,
        model: "zai-org/GLM-5.2",
        baseUrl: "http://127.0.0.1:18000/v1",
        wireApi: "responses" as const
      }
    };
    expect(
      sendParamsZod.parse({
        name: "provider-refresh",
        message: "Continue with the current provider configuration.",
        ...refresh
      })
    ).toMatchObject(refresh);
    expect(
      pluginSendParamsZod.safeParse({
        name: "provider-refresh",
        message: "Try to refresh a provider from the plugin.",
        ...refresh
      }).success
    ).toBe(false);
    const toolProperties = (
      toolSendSchema as unknown as { properties: Record<string, unknown> }
    ).properties;
    expect(toolProperties).not.toHaveProperty("modelProviderId");
    expect(toolProperties).not.toHaveProperty("modelProvider");
  });

  it.each(["xhigh", "max", "ultra"] as const)(
    "accepts the Codex %s reasoning level on start and follow-up turns",
    (effort) => {
      expect(
        startParamsZod.parse({
          agent: "codex",
          name: "demo",
          directory: "/tmp/demo",
          task: "Use the requested reasoning level.",
          effort
        }).effort
      ).toBe(effort);
      expect(
        sendParamsZod.parse({
          name: "demo",
          message: "Keep using the requested reasoning level.",
          effort
        }).effort
      ).toBe(effort);
    }
  );

  it("exposes a follow-up effort override through the send tool", () => {
    const toolProperties = (
      toolSendSchema as unknown as { properties: Record<string, unknown> }
    ).properties;
    expect(toolProperties).toHaveProperty("effort");
  });

  it.each(["none", "minimal", "ultracode"] as const)(
    "accepts and exposes provider-specific reasoning mode %s",
    (effort) => {
      expect(
        startParamsZod.parse({
          agent: "codex",
          name: "provider-demo",
          directory: "/tmp/provider-demo",
          task: "Use the provider-specific reasoning mode.",
          effort,
          modelProvider: {
            id: "local-glm",
            model: "zai-org/GLM-5.2",
            reasoningProfile: "glm-5.2"
          }
        }).effort
      ).toBe(effort);

      const startProperties = (
        toolStartSchema as unknown as {
          properties: { effort: { anyOf: Array<{ const: string }> } };
        }
      ).properties;
      expect(startProperties.effort.anyOf.map((entry) => entry.const)).toContain(effort);
    }
  );

  it.each(["none", "minimal", "ultracode"] as const)(
    "rejects provider-specific reasoning mode %s for mixed-agent projects",
    (effort) => {
      expect(
        projectCreateParamsZod.safeParse({
          name: "mixed-project",
          rootDir: "/tmp/mixed-project",
          effort
        }).success
      ).toBe(false);

      const projectProperties = (
        toolProjectCreateSchema as unknown as {
          properties: { effort: { anyOf: Array<{ const: string }> } };
        }
      ).properties;
      expect(projectProperties.effort.anyOf.map((entry) => entry.const)).not.toContain(
        effort
      );
    }
  );
});
