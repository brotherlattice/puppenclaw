import type { PluginLogger } from "openclaw/plugin-sdk/core";

import { ensureError, PuppenclawError } from "../shared/errors.js";
import type {
  CostParams,
  ForkParams,
  ParsedPluginConfig,
  ResumeParams,
  SendParams,
  StartParams,
  StatusParams,
  StopParams,
  ToolResult
} from "../shared/types.js";
import type { OutputRouter } from "../plugin/output-router.js";
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

  async cost(params: CostParams): Promise<ToolResult> {
    await this.ensureHealthy();
    return this.request({
      method: "GET",
      path: `/session/${encodeURIComponent(params.name)}/cost`
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
              }
            }),
        ...(init.body != null ? { body: JSON.stringify(init.body) } : {})
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
      this.deps.logger.warn(`Puppenclaw daemon request failed: ${err.message}`);
      throw err;
    }
  }
}
