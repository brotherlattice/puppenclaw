import { describe, expect, it } from "vitest";

import { pluginConfigZod, pluginManifestConfigSchema } from "../../src/shared/schema.js";

// Keys of pluginConfigZod that are intentionally NOT exposed in the generated
// openclaw.plugin.json config schema. Every entry must have a comment stating
// why it is server-only. Keep this list empty unless there is a real reason.
const MANIFEST_EXCLUDED_KEYS: ReadonlySet<string> = new Set([]);

describe("plugin config schema drift", () => {
  it("exposes every pluginConfigZod top-level key in pluginManifestConfigSchema", () => {
    const manifestKeys = new Set(
      Object.keys(pluginManifestConfigSchema.properties as Record<string, unknown>)
    );
    const configKeys = Object.keys(pluginConfigZod.shape);
    const missing = configKeys.filter(
      (key) => !MANIFEST_EXCLUDED_KEYS.has(key) && !manifestKeys.has(key)
    );
    expect(
      missing,
      `pluginManifestConfigSchema.properties is missing config keys: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("does not advertise manifest config keys that pluginConfigZod would reject", () => {
    const configKeys = new Set(Object.keys(pluginConfigZod.shape));
    const unknown = Object.keys(
      pluginManifestConfigSchema.properties as Record<string, unknown>
    ).filter((key) => !configKeys.has(key));
    expect(
      unknown,
      `pluginManifestConfigSchema advertises keys unknown to pluginConfigZod: ${unknown.join(", ")}`
    ).toEqual([]);
  });

  it("keeps the exclusion allowlist limited to real config keys", () => {
    const configKeys = new Set(Object.keys(pluginConfigZod.shape));
    for (const key of MANIFEST_EXCLUDED_KEYS) {
      expect(configKeys.has(key), `allowlisted key "${key}" is not in pluginConfigZod`).toBe(true);
    }
  });
});
