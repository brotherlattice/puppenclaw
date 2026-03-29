import type { PluginLogger } from "openclaw/plugin-sdk/core";

import { ensureError, PuppenclawError } from "../shared/errors.js";
import type {
  ArtifactListParams,
  CampaignActionParams,
  CampaignRunParams,
  CampaignStatusParams,
  ContextSyncParams,
  ParsedPluginConfig,
  ProjectCreateParams,
  ToolResult,
  WorkerManifestInput
} from "../shared/types.js";
import type { IOrchestrator } from "./types.js";

type JsonRequestInit = {
  method?: "GET" | "POST";
  path: string;
  body?: unknown;
};

export class DaemonOrchestratorClient implements IOrchestrator {
  private healthChecked = false;

  constructor(
    private readonly deps: {
      config: ParsedPluginConfig;
      logger: PluginLogger;
    }
  ) {}

  async createProject(params: ProjectCreateParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({ method: "POST", path: "/orchestrator/project", body: params });
  }

  async registerWorker(params: WorkerManifestInput): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({ method: "POST", path: "/orchestrator/worker", body: params });
  }

  async syncContext(params: ContextSyncParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({ method: "POST", path: "/orchestrator/context-sync", body: params });
  }

  async runCampaign(params: CampaignRunParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({ method: "POST", path: "/orchestrator/campaign", body: params });
  }

  async status(params: CampaignStatusParams = {}): Promise<ToolResult> {
    await this.ensureHealthy();
    const url = new URL("/orchestrator/status", this.deps.config.daemonUrl);
    if (params.campaignId != null) {
      url.searchParams.set("campaignId", params.campaignId);
    }
    if (params.projectId != null) {
      url.searchParams.set("projectId", params.projectId);
    }
    return this.request({ method: "GET", path: `${url.pathname}${url.search}` });
  }

  async listArtifacts(params: ArtifactListParams = {}): Promise<ToolResult> {
    await this.ensureHealthy();
    const url = new URL("/orchestrator/artifacts", this.deps.config.daemonUrl);
    if (params.campaignId != null) {
      url.searchParams.set("campaignId", params.campaignId);
    }
    if (params.projectId != null) {
      url.searchParams.set("projectId", params.projectId);
    }
    return this.request({ method: "GET", path: `${url.pathname}${url.search}` });
  }

  async approve(params: CampaignActionParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({ method: "POST", path: "/orchestrator/approve", body: params });
  }

  async cancel(params: CampaignActionParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({ method: "POST", path: "/orchestrator/cancel", body: params });
  }

  private async ensureHealthy(): Promise<void> {
    if (this.healthChecked) {
      return;
    }
    try {
      const response = await fetch(new URL("/health", this.deps.config.daemonUrl), { method: "GET" });
      if (!response.ok) {
        throw new Error(`daemon health check failed with ${response.status}`);
      }
      this.healthChecked = true;
    } catch (error) {
      const err = ensureError(error);
      throw new PuppenclawError(
        "DAEMON_UNREACHABLE",
        `Puppenclaw daemon is unreachable at ${this.deps.config.daemonUrl}: ${err.message}`
      );
    }
  }

  private async request(init: JsonRequestInit): Promise<ToolResult> {
    try {
      const response = await fetch(new URL(init.path, this.deps.config.daemonUrl), {
        method: init.method ?? (init.body == null ? "GET" : "POST"),
        ...(init.body == null
          ? {}
          : {
              headers: {
                "content-type": "application/json"
              },
              body: JSON.stringify(init.body)
            })
      });
      const payload = (await response.json()) as ToolResult | { error: string };
      if (!response.ok) {
        const message =
          payload != null &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof payload.error === "string"
            ? payload.error
            : `daemon request failed with ${response.status}`;
        throw new PuppenclawError("DAEMON_REQUEST_FAILED", message);
      }
      return payload as ToolResult;
    } catch (error) {
      const err = ensureError(error);
      this.deps.logger.warn(`Puppenclaw orchestrator request failed: ${err.message}`);
      throw err;
    }
  }
}
