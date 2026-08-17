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
import { DaemonOrchestratorClient } from "../orchestrator/client.js";
import { OrchestratorRuntime } from "../orchestrator/runtime.js";
import { OrchestratorStore } from "../orchestrator/store.js";
import type { IOrchestrator } from "../orchestrator/types.js";
import { SessionStore } from "../shared/store.js";
import { UsageLedgerStore } from "../shared/usage-ledger.js";
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
  orchestratorStore: OrchestratorStore | null;
  usageLedger: UsageLedgerStore | null;
  manager: ISessionManager | null;
  orchestrator: IOrchestrator | null;
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
  orchestratorStore: null,
  usageLedger: null,
  manager: null,
  orchestrator: null,
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
                `Orchestrator GC failed: ${error instanceof Error ? error.message : String(error)}`
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
      await cleanupInitializedState();
    }
  };
}

export async function getPuppenclawManager(): Promise<ISessionManager> {
  await ensureInitialized();
  if (state.manager == null) {
    throw new Error("Orchestrator manager is unavailable");
  }
  return state.manager;
}

export async function getPuppenclawStore(): Promise<SessionStore> {
  await ensureInitialized();
  if (state.store == null) {
    throw new Error("Orchestrator store is unavailable");
  }
  return state.store;
}

export async function getPuppenclawOutputRouter(): Promise<OutputRouter> {
  await ensureInitialized();
  if (state.outputRouter == null) {
    throw new Error("Orchestrator output router is unavailable");
  }
  return state.outputRouter;
}

export async function getPuppenclawOrchestrator(): Promise<IOrchestrator> {
  await ensureInitialized();
  if (state.orchestrator == null) {
    throw new Error("Orchestrator campaign runtime is unavailable");
  }
  return state.orchestrator;
}

export async function getPuppenclawOrchestratorStore(): Promise<OrchestratorStore> {
  await ensureInitialized();
  if (state.orchestratorStore == null) {
    throw new Error("Orchestrator campaign store is unavailable");
  }
  return state.orchestratorStore;
}

export async function getPuppenclawUsageLedger(): Promise<UsageLedgerStore> {
  await ensureInitialized();
  if (state.usageLedger == null) {
    throw new Error("Orchestrator usage ledger is unavailable");
  }
  return state.usageLedger;
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
  if (
    state.manager != null &&
    state.store != null &&
    state.outputRouter != null &&
    state.orchestratorStore != null &&
    state.usageLedger != null &&
    state.orchestrator != null
  ) {
    return;
  }
  if (state.initPromise != null) {
    await state.initPromise;
    return;
  }
  state.initPromise = (async () => {
    const logger = state.logger ?? ctx?.logger;
    if (logger == null) {
      throw new Error("Orchestrator logger is unavailable");
    }
    if (state.dataDir == null) {
      const fallbackStateDir =
        ctx?.stateDir ?? process.env.OPENCLAW_STATE_DIR ?? join(process.cwd(), ".puppenclaw");
      state.dataDir = resolvePluginDataDir({
        stateDir: fallbackStateDir,
        ...(state.resolvePath != null ? { resolvePath: state.resolvePath } : {})
      });
    }
    await ensureDir(state.dataDir);
    state.store = await SessionStore.open(state.dataDir);
    state.orchestratorStore = await OrchestratorStore.open(join(state.dataDir, "orchestrator"));
    state.usageLedger = await UsageLedgerStore.open(join(state.dataDir, "usage"));
    state.outputRouter = new OutputRouter(logger);
    state.manager = createSessionManager({
      config: getConfiguredPluginConfig(),
      logger,
      store: state.store,
      outputRouter: state.outputRouter,
      ledger: state.usageLedger
    });
    await state.manager.reconcilePersistedSessions?.();
    if (getConfiguredPluginConfig().backend === "daemon") {
      state.orchestrator = new DaemonOrchestratorClient({
        config: getConfiguredPluginConfig(),
        logger
      });
    } else {
      const orchestrator = new OrchestratorRuntime({
        config: getConfiguredPluginConfig(),
        logger,
        store: state.orchestratorStore,
        sessionStore: state.store,
        sessionManager: state.manager
      });
      await orchestrator.recoverInterruptedCampaigns();
      state.orchestrator = orchestrator;
    }
  })();
  try {
    await state.initPromise;
  } catch (error) {
    await cleanupInitializedState();
    throw error;
  } finally {
    state.initPromise = null;
  }
}

async function cleanupInitializedState(): Promise<void> {
  const store = state.store;
  const orchestratorStore = state.orchestratorStore;
  const usageLedger = state.usageLedger;
  state.store = null;
  state.orchestratorStore = null;
  state.usageLedger = null;
  state.manager = null;
  state.orchestrator = null;
  state.outputRouter = null;
  try {
    orchestratorStore?.close();
  } catch (error) {
    state.logger?.warn(
      `Unable to close partially initialized Orchestrator state: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  try {
    usageLedger?.close();
  } catch (error) {
    state.logger?.warn(
      `Unable to close partially initialized usage state: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  await store?.close().catch((error) => {
    state.logger?.warn(
      `Unable to release the session-state owner lease: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
}
