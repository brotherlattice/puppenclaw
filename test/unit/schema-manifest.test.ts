import { describe, expect, it } from "vitest";

import { buildPluginManifest, pluginConfigZod } from "../../src/shared/schema.js";

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
});
