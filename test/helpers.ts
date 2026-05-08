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
  const fixtureDir = dirname(fileURLToPath(import.meta.url));
  if (process.platform === "win32") {
    const filePath = resolve(fixtureDir, "./fixtures/fake-acpx.mjs");
    return `node ${quoteCommandPart(filePath)}`;
  }
  const filePath = resolve(fixtureDir, "./fixtures/fake-acpx.sh");
  await chmod(filePath, 0o755);
  return filePath;
}

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,\\-]+$/u.test(value)) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
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

export function nodePrintCommand(text: string): string {
  return `node -e "process.stdout.write(Buffer.from('${base64(text)}','base64').toString('utf8'))"`;
}

export function nodeFileExistsCommand(path: string): string {
  return `node -e "if(!require('node:fs').existsSync(Buffer.from('${base64(
    path
  )}','base64').toString('utf8')))process.exit(1)"`;
}

export function nodeStdinToNullAndPrintCommand(text: string): string {
  return `node -e "process.stdin.resume();process.stdin.on('end',function(){process.stdout.write(Buffer.from('${base64(
    text
  )}','base64').toString('utf8'))})"`;
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
