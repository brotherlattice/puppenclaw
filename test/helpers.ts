import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionStore } from "../src/shared/store.js";
import { pluginConfigZod } from "../src/shared/schema.js";
import { OutputRouter } from "../src/plugin/output-router.js";

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function resolveFakeAcpxCommand(): Promise<string> {
  const filePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "./fixtures/fake-acpx.sh"
  );
  await chmod(filePath, 0o755);
  return filePath;
}

export async function createStoreAndRouter(rootDir: string): Promise<{
  store: SessionStore;
  outputRouter: OutputRouter;
}> {
  return {
    store: await SessionStore.open(rootDir),
    outputRouter: new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    })
  };
}

export function makeConfig(overrides: Record<string, unknown> = {}) {
  return pluginConfigZod.parse({
    backend: "local",
    daemonUrl: "http://127.0.0.1:18795",
    defaultAgent: "claude",
    maxSessions: 5,
    permissionMode: "approve-reads",
    sessionTtlMinutes: 60,
    streamOutput: true,
    acpxCommand: undefined,
    agentCommands: {},
    mcpServers: {},
    remoteControl: {
      mediated: {
        enabled: true
      },
      purePipe: {
        enabled: false,
        allowFrom: [],
        allowedAgents: []
      },
      requireConversationBinding: true
    },
    ...overrides
  });
}
