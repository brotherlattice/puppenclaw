import { join } from "node:path";

import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
  PluginRuntime
} from "openclaw/plugin-sdk/core";

import { createSessionManager } from "../manager/factory.js";
import type { ISessionManager } from "../manager/interface.js";
import { SessionStore } from "../shared/store.js";
import type { ParsedPluginConfig, SessionInfo } from "../shared/types.js";
import { ensureDir } from "../shared/utils.js";
import { readPluginConfig, resolvePluginDataDir } from "./config.js";
import { OutputRouter } from "./output-router.js";

type RegistrationState = {
  runtime: PluginRuntime | null;
  logger: PluginLogger | null;
  resolvePath: ((input: string) => string) | null;
  pluginConfig: ParsedPluginConfig | null;
  dataDir: string | null;
  store: SessionStore | null;
  manager: ISessionManager | null;
  outputRouter: OutputRouter | null;
  gcTimer: NodeJS.Timeout | null;
  initPromise: Promise<void> | null;
};

const state: RegistrationState = {
  runtime: null,
  logger: null,
  resolvePath: null,
  pluginConfig: null,
  dataDir: null,
  store: null,
  manager: null,
  outputRouter: null,
  gcTimer: null,
  initPromise: null
};

export function configurePuppenclawRegistration(api: OpenClawPluginApi): void {
  state.runtime = api.runtime;
  state.logger = api.logger;
  state.resolvePath = api.resolvePath ?? null;
  state.pluginConfig = readPluginConfig(api.pluginConfig ?? {});
}

export function createPuppenclawService(): OpenClawPluginService {
  return {
    id: "puppenclaw-gc",
    start: async (ctx: OpenClawPluginServiceContext) => {
      state.dataDir = resolvePluginDataDir({
        stateDir: ctx.stateDir,
        ...(state.resolvePath != null ? { resolvePath: state.resolvePath } : {})
      });
      await ensureInitialized(ctx);
      if (state.gcTimer == null) {
        state.gcTimer = setInterval(() => {
          void getPuppenclawManager()
            .then((manager) => manager.gc())
            .catch((error) => {
              const logger = state.logger ?? ctx.logger;
              logger.warn(
                `Puppenclaw GC failed: ${error instanceof Error ? error.message : String(error)}`
              );
            });
        }, 60_000);
      }
    },
    stop: async () => {
      if (state.gcTimer != null) {
        clearInterval(state.gcTimer);
        state.gcTimer = null;
      }
    }
  };
}

export async function getPuppenclawManager(): Promise<ISessionManager> {
  await ensureInitialized();
  if (state.manager == null) {
    throw new Error("Puppenclaw manager is unavailable");
  }
  return state.manager;
}

export async function getPuppenclawStore(): Promise<SessionStore> {
  await ensureInitialized();
  if (state.store == null) {
    throw new Error("Puppenclaw store is unavailable");
  }
  return state.store;
}

export async function getPuppenclawOutputRouter(): Promise<OutputRouter> {
  await ensureInitialized();
  if (state.outputRouter == null) {
    throw new Error("Puppenclaw output router is unavailable");
  }
  return state.outputRouter;
}

export function getConfiguredPluginConfig(): ParsedPluginConfig {
  return state.pluginConfig ?? readPluginConfig({});
}

export async function patchStoredSession(
  name: string,
  patch: (session: SessionInfo | null) => SessionInfo | null
): Promise<SessionInfo | null> {
  const store = await getPuppenclawStore();
  return store.patchSession(name, patch);
}

async function ensureInitialized(ctx?: OpenClawPluginServiceContext): Promise<void> {
  if (state.manager != null && state.store != null && state.outputRouter != null) {
    return;
  }
  if (state.initPromise != null) {
    await state.initPromise;
    return;
  }
  state.initPromise = (async () => {
    const logger = state.logger ?? ctx?.logger;
    if (logger == null) {
      throw new Error("Puppenclaw logger is unavailable");
    }
    if (state.dataDir == null) {
      const fallbackStateDir = ctx?.stateDir ?? join(process.cwd(), ".puppenclaw");
      state.dataDir = resolvePluginDataDir({
        stateDir: fallbackStateDir,
        ...(state.resolvePath != null ? { resolvePath: state.resolvePath } : {})
      });
    }
    await ensureDir(state.dataDir);
    state.store = await SessionStore.open(state.dataDir);
    state.outputRouter = new OutputRouter(logger);
    state.manager = createSessionManager({
      config: getConfiguredPluginConfig(),
      logger,
      store: state.store,
      outputRouter: state.outputRouter
    });
  })();
  try {
    await state.initPromise;
  } finally {
    state.initPromise = null;
  }
}
