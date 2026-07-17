export const REASONING_MODE_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode"
] as const;

export type ReasoningMode = (typeof REASONING_MODE_VALUES)[number];
export type ReasoningProfile = "claude" | "codex" | "glm-5.2";
export type EffectiveReasoningMode = ReasoningMode;

type ReasoningSubject = {
  agent: "claude" | "codex";
  model?: string | undefined;
  modelProvider?: {
    model: string;
    reasoningProfile?: ReasoningProfile | undefined;
  } | undefined;
};

export type ReasoningResolution = {
  profile: ReasoningProfile;
  requested: ReasoningMode;
  effective: EffectiveReasoningMode;
  runtimeValue: ReasoningMode;
  warning?: string;
};

const CLAUDE_MODES = new Set<ReasoningMode>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);
const CODEX_MODES = new Set<ReasoningMode>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);
const GLM_52_MODES = new Set<ReasoningMode>(REASONING_MODE_VALUES);

export const REASONING_CAPABILITIES = {
  version: 1,
  field: "effort",
  profiles: [
    {
      id: "claude",
      label: "Claude Code",
      modes: [
        { id: "low", label: "Low", kind: "effort" },
        { id: "medium", label: "Medium", kind: "effort" },
        { id: "high", label: "High", kind: "effort" },
        { id: "xhigh", label: "XHigh", kind: "effort" },
        { id: "max", label: "Max", kind: "effort" },
        {
          id: "ultracode",
          label: "Ultracode",
          kind: "workflow",
          selectable: false,
          availability: "blocked-by-acp",
          defaultAdapterSupport: "unavailable",
          description:
            "Claude Code xhigh reasoning with automatic dynamic-workflow orchestration. It is exposed for capability discovery but cannot be selected until ACP supports its approval, progress, background-run, and multiplexing lifecycle."
        }
      ],
      aliases: [{ id: "ultra", effective: "max", deprecated: true }]
    },
    {
      id: "codex",
      label: "Codex",
      modes: [
        { id: "low", label: "Low", kind: "effort" },
        { id: "medium", label: "Medium", kind: "effort" },
        { id: "high", label: "High", kind: "effort" },
        { id: "xhigh", label: "XHigh", kind: "effort" },
        { id: "max", label: "Max", kind: "effort" },
        { id: "ultra", label: "Ultra", kind: "effort" }
      ],
      aliases: []
    },
    {
      id: "glm-5.2",
      label: "GLM-5.2",
      modes: [
        {
          id: "none",
          label: "Off",
          kind: "thinking",
          description: "Disable thinking."
        },
        {
          id: "high",
          label: "High",
          kind: "effort",
          description: "GLM-5.2's standard thinking depth."
        },
        {
          id: "max",
          label: "Max",
          kind: "effort",
          description: "GLM-5.2's maximum thinking depth."
        }
      ],
      aliases: [
        { id: "minimal", effective: "none" },
        { id: "low", effective: "high" },
        { id: "medium", effective: "high" },
        { id: "xhigh", effective: "max" },
        { id: "ultra", effective: "max" },
        { id: "ultracode", effective: "max" }
      ]
    }
  ]
} as const;

function looksLikeGlm52(model: string | undefined): boolean {
  if (model == null) {
    return false;
  }
  return /(?:^|[^a-z0-9])glm[_.-]?5[_.-]?2(?=$|[^a-z0-9])/iu.test(model.trim());
}

export function reasoningProfileFor(subject: ReasoningSubject): ReasoningProfile {
  if (subject.modelProvider?.reasoningProfile != null) {
    return subject.modelProvider.reasoningProfile;
  }
  if (looksLikeGlm52(subject.modelProvider?.model ?? subject.model)) {
    return "glm-5.2";
  }
  return subject.agent;
}

export function acceptedReasoningModes(profile: ReasoningProfile): ReasoningMode[] {
  const modes =
    profile === "claude" ? CLAUDE_MODES : profile === "codex" ? CODEX_MODES : GLM_52_MODES;
  return REASONING_MODE_VALUES.filter((mode) => modes.has(mode));
}

export function resolveReasoningMode(
  subject: ReasoningSubject,
  requested: ReasoningMode
): ReasoningResolution | null {
  const profile = reasoningProfileFor(subject);
  const accepted =
    profile === "claude" ? CLAUDE_MODES : profile === "codex" ? CODEX_MODES : GLM_52_MODES;
  if (!accepted.has(requested)) {
    return null;
  }

  if (profile === "claude" && requested === "ultra") {
    return {
      profile,
      requested,
      effective: "max",
      runtimeValue: "max",
      warning: 'Claude does not define an "ultra" effort level; legacy Ultra was mapped to Claude Max.'
    };
  }

  if (profile === "glm-5.2") {
    const effective =
      requested === "none" || requested === "minimal"
        ? "none"
        : requested === "low" || requested === "medium" || requested === "high"
          ? "high"
          : "max";
    return {
      profile,
      requested,
      effective,
      runtimeValue: effective === "none" ? "minimal" : effective,
      ...(requested !== effective
        ? {
            warning: `GLM-5.2 reasoning mode "${requested}" maps to its effective "${effective}" tier.`
          }
        : {})
    };
  }

  return {
    profile,
    requested,
    effective: requested,
    runtimeValue: requested
  };
}
