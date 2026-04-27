import { describe, expect, it } from "vitest";

import {
  buildPluginManifest,
  pluginConfigZod,
  reassessmentStartParamsZod,
  REMOTE_CONTROL_VERBS
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
});
