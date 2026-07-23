import { ensureError, PuppenclawError } from "../shared/errors.js";
import type { PluginLogger } from "../shared/logger.js";
import type { OutputRouter } from "../shared/output-router.js";
import type {
  CostParams,
  FocusParams,
  ForkParams,
  ParsedPluginConfig,
  QuiesceParams,
  QuiescenceReleaseParams,
  ResumeParams,
  SendParams,
  StartParams,
  StatusParams,
  StopParams,
  SuspendParams,
  ToolResult,
  UnfocusParams
} from "../shared/types.js";
import type { ISessionManager } from "./interface.js";

type JsonRequestInit = {
  method?: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
};

export class DaemonSessionManager implements ISessionManager {
  private healthChecked = false;

  constructor(
    private readonly deps: {
      config: ParsedPluginConfig;
      logger: PluginLogger;
      outputRouter: OutputRouter;
    }
  ) {}

  async start(params: StartParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "POST",
      path: "/session/start",
      body: params
    });
  }

  async send(params: SendParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "POST",
      path: `/session/${encodeURIComponent(params.name)}/send`,
      body: params
    });
  }

  async stop(params: StopParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "DELETE",
      path: `/session/${encodeURIComponent(params.name)}`
    });
  }

  async resume(params: ResumeParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "POST",
      path: `/session/${encodeURIComponent(params.name)}/resume`,
      body: params
    });
  }

  async suspend(params: SuspendParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "POST",
      path: `/session/${encodeURIComponent(params.name)}/suspend`,
      body: params
    });
  }

  async focus(params: FocusParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "POST",
      path: `/session/${encodeURIComponent(params.name)}/focus`,
      body: params
    });
  }

  async unfocus(params: UnfocusParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "POST",
      path: `/session/${encodeURIComponent(params.name)}/unfocus`,
      body: params
    });
  }

  async fork(params: ForkParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "POST",
      path: `/session/${encodeURIComponent(params.source)}/fork`,
      body: params
    });
  }

  async status(params: StatusParams = {}): Promise<ToolResult> {
    await this.ensureHealthy();
    if (params.name != null) {
      return this.request({
        method: "GET",
        path: `/session/${encodeURIComponent(params.name)}`
      });
    }
    return this.request({
      method: "GET",
      path: "/sessions"
    });
  }

  async output(params: StatusParams): Promise<ToolResult> {
    await this.ensureHealthy();
    if (params.name == null) {
      throw new PuppenclawError("MISSING_SESSION", "Session name is required.");
    }
    return this.request({
      method: "GET",
      path: `/session/${encodeURIComponent(params.name)}/output`
    });
  }

  async cost(params: CostParams = {}): Promise<ToolResult> {
    await this.ensureHealthy();
    if (params.name == null) {
      const query = new URLSearchParams();
      if (params.since != null) {
        query.set("since", params.since);
      }
      if (params.format != null) {
        query.set("format", params.format);
      }
      const queryString = query.toString();
      return this.request({
        method: "GET",
        path: queryString.length > 0 ? `/usage?${queryString}` : "/usage"
      });
    }
    return this.request({
      method: "GET",
      path: `/session/${encodeURIComponent(params.name)}/cost`
    });
  }

  async purge(params: StopParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "POST",
      path: `/session/${encodeURIComponent(params.name)}/purge`
    });
  }

  async quiesce(params: QuiesceParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "POST",
      path: `/session/${encodeURIComponent(params.name)}/quiesce`,
      body: {}
    });
  }

  async releaseQuiescence(params: QuiescenceReleaseParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "POST",
      path: `/session/${encodeURIComponent(params.name)}/quiesce/release`,
      body: { epoch: params.epoch }
    });
  }

  async gc(): Promise<void> {
    await this.ensureHealthy();
    await this.request({
      method: "POST",
      path: "/gc"
    });
  }

  private async ensureHealthy(): Promise<void> {
    if (this.healthChecked) {
      return;
    }
    try {
      const response = await fetch(new URL("/health", this.deps.config.daemonUrl), {
        method: "GET"
      });
      if (!response.ok) {
        throw new Error(`daemon health check failed with ${response.status}`);
      }
      this.healthChecked = true;
    } catch (error) {
      const err = ensureError(error);
      throw new PuppenclawError(
        "DAEMON_UNREACHABLE",
        `Orchestrator daemon is unreachable at ${this.deps.config.daemonUrl}: ${err.message}`
      );
    }
  }

  private async request(init: JsonRequestInit): Promise<ToolResult> {
    try {
      const authToken = this.deps.config.daemonAuthToken?.trim() ?? "";
      const headers: Record<string, string> = {
        ...(init.body != null ? { "content-type": "application/json" } : {}),
        ...(authToken.length > 0 ? { authorization: `Bearer ${authToken}` } : {})
      };
      const response = await fetch(new URL(init.path, this.deps.config.daemonUrl), {
        method: init.method ?? (init.body == null ? "GET" : "POST"),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(init.body != null ? { body: JSON.stringify(init.body) } : {})
      });
      const payload = (await response.json()) as
        | ToolResult
        | {
            error?: string;
            code?: string;
            details?: Record<string, unknown>;
          };
      if (!response.ok) {
        const message =
          payload != null &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof payload.error === "string"
            ? payload.error
            : `daemon request failed with ${response.status}`;
        const code =
          payload != null &&
          typeof payload === "object" &&
          "code" in payload &&
          typeof payload.code === "string"
            ? payload.code
            : "DAEMON_REQUEST_FAILED";
        const details =
          payload != null &&
          typeof payload === "object" &&
          "details" in payload &&
          payload.details != null &&
          typeof payload.details === "object"
            ? payload.details
            : undefined;
        throw new PuppenclawError(code, message, details);
      }
      return payload as ToolResult;
    } catch (error) {
      const err = ensureError(error);
      this.deps.logger.warn(`Orchestrator daemon request failed: ${err.message}`);
      throw err;
    }
  }
}
