import { describe, expect, it } from "vitest";

import {
  REASONING_CAPABILITIES,
  acceptedReasoningModes,
  reasoningProfileFor,
  resolveReasoningMode,
  type ReasoningMode,
  type ReasoningProfile
} from "../../src/shared/reasoning.js";

describe("reasoning profiles", () => {
  it.each([
    "glm-5.2",
    "GLM-5-2",
    "zai-org/GLM-5.2",
    "local.glm_5_2",
    "glm-5.2[1m]"
  ])("detects GLM-5.2 from model name %s", (model) => {
    expect(reasoningProfileFor({ agent: "codex", model })).toBe("glm-5.2");
  });

  it("prefers an explicit provider reasoning profile over model-name detection", () => {
    expect(
      reasoningProfileFor({
        agent: "codex",
        model: "glm-5.2",
        modelProvider: {
          model: "glm-5.2",
          reasoningProfile: "codex"
        }
      })
    ).toBe("codex");
    expect(
      reasoningProfileFor({
        agent: "claude",
        modelProvider: {
          model: "custom-relay-name",
          reasoningProfile: "glm-5.2"
        }
      })
    ).toBe("glm-5.2");
  });

  it.each([
    ["none", "none"],
    ["minimal", "none"],
    ["low", "high"],
    ["medium", "high"],
    ["high", "high"],
    ["xhigh", "max"],
    ["max", "max"],
    ["ultra", "max"],
    ["ultracode", "max"]
  ] as const)("maps GLM-5.2 %s to its effective %s tier", (requested, effective) => {
    const resolution = resolveReasoningMode(
      {
        agent: "claude",
        modelProvider: {
          model: "glm-5.2",
          reasoningProfile: "glm-5.2"
        }
      },
      requested
    );

    expect(resolution).toMatchObject({
      profile: "glm-5.2",
      requested,
      effective,
      runtimeValue: effective === "none" ? "minimal" : effective
    });
    if (requested === effective) {
      expect(resolution?.warning).toBeUndefined();
    } else {
      expect(resolution?.warning).toContain(`maps to its effective "${effective}" tier`);
    }
  });

  it("maps legacy Claude Ultra to Max with an explicit compatibility warning", () => {
    expect(resolveReasoningMode({ agent: "claude" }, "ultra")).toEqual({
      profile: "claude",
      requested: "ultra",
      effective: "max",
      runtimeValue: "max",
      warning: 'Claude does not define an "ultra" effort level; legacy Ultra was mapped to Claude Max.'
    });
  });

  it("exposes Claude Ultracode as an unavailable workflow capability", () => {
    expect(resolveReasoningMode({ agent: "claude" }, "ultracode")).toBeNull();
    const claude = REASONING_CAPABILITIES.profiles.find(
      (profile) => profile.id === "claude"
    );
    expect(claude?.modes.find((mode) => mode.id === "ultracode")).toMatchObject({
      kind: "workflow",
      selectable: false,
      availability: "blocked-by-acp",
      defaultAdapterSupport: "unavailable"
    });
  });

  it.each(["none", "minimal", "ultracode"] as const)(
    "rejects unsupported Codex mode %s",
    (requested) => {
      expect(resolveReasoningMode({ agent: "codex" }, requested)).toBeNull();
      expect(acceptedReasoningModes("codex")).not.toContain(requested);
    }
  );

  it.each([
    ["claude", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["codex", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    [
      "glm-5.2",
      ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]
    ]
  ] satisfies Array<[ReasoningProfile, ReasoningMode[]]>) (
    "advertises only accepted %s modes",
    (profile, expected) => {
      expect(acceptedReasoningModes(profile)).toEqual(expected);
    }
  );
});
