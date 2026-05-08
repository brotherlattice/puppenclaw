import type { ParsedPluginConfig } from "../shared/types.js";
import type { SessionStore } from "../shared/store.js";
import type { PluginLogger } from "../shared/logger.js";
import type { OutputRouter } from "../shared/output-router.js";
import { AcpxSessionManager } from "./acpx.js";
import { DaemonSessionManager } from "./daemon.js";
import type { ISessionManager } from "./interface.js";

export function createSessionManager(params: {
  config: ParsedPluginConfig;
  logger: PluginLogger;
  store: SessionStore;
  outputRouter: OutputRouter;
}): ISessionManager {
  if (params.config.backend === "daemon") {
    return new DaemonSessionManager({
      config: params.config,
      logger: params.logger,
      outputRouter: params.outputRouter
    });
  }
  return new AcpxSessionManager({
    config: params.config,
    logger: params.logger,
    store: params.store,
    outputRouter: params.outputRouter
  });
}
