/**
 * Emits contract fixtures for the daemon's session status and output envelopes.
 *
 * Run with: npx tsx scripts/emit-contract-fixtures.ts
 *
 * The generator seeds a session store with one session per scenario, boots the
 * real daemon HTTP server (createDaemonServer) against it, and captures the
 * exact JSON bodies of GET /session/:name and GET /session/:name/output via
 * Fastify's inject — the same route handlers, manager methods, and envelope
 * builders that serve production traffic. Consumer-side contract tests can
 * treat the committed fixtures as the daemon's authoritative wire format;
 * test/unit/contract-fixtures.test.ts regenerates them in-memory and fails
 * when the emitted shape drifts.
 *
 * Determinism post-processing applied to the captured bodies (both the
 * details payload and the JSON echoed inside content[0].text):
 * - the temporary workspace directory is replaced with /workspace/project;
 * - the live turn process's pid, process group id, and process start identity
 *   are replaced with the fixed values 431602, 431600, and "431602:8888888";
 * - turn.ageMs and turn.outputAgeMs (computed from Date.now() against the
 *   fixed seeded timestamps) are replaced with 61000 and 32000.
 * All other values are seeded with fixed timestamps and are deterministic.
 *
 * Requires Linux: turn liveness classification probes /proc process identity.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createDaemonServer } from "../src/daemon/server.js";
import { SESSION_STORE_VERSION } from "../src/shared/schema.js";
import type { SessionInfo, StoredState } from "../src/shared/types.js";
import { writeJsonFileAtomic } from "../src/shared/utils.js";
import { makeConfig, resolveFakeAcpxCommand } from "../test/helpers.js";

export const CONTRACT_SCENARIOS = [
  "idle",
  "running",
  "orphaned",
  "legacy-no-turn",
  "failed",
  "quiesced"
] as const;

export type ContractScenario = (typeof CONTRACT_SCENARIOS)[number];

export type ContractCapture = {
  status: unknown;
  output: unknown;
};

export const CONTRACT_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
  "contract"
);

const FIXED_WORKSPACE = "/workspace/project";
const FIXED_PID = 431_602;
const FIXED_PROCESS_GROUP_ID = FIXED_PID;
const FIXED_PROCESS_START_IDENTITY = "431602:8888888";
const FIXED_AGE_MS = 61_000;
const FIXED_OUTPUT_AGE_MS = 32_000;
const DEAD_PID = 999_999_999;

const T_CREATED = "2026-01-01T10:00:00.000Z";
const T_USER = "2026-01-01T10:00:05.000Z";
const T_ASSISTANT = "2026-01-01T10:00:20.000Z";
const T_TURN_STARTED = "2026-01-01T10:01:00.000Z";
const T_TURN_OUTPUT = "2026-01-01T10:01:30.000Z";
const T_LAST_ACTIVITY = "2026-01-01T10:02:00.000Z";

type LiveTurnProcess = {
  pid: number;
  processGroupId: number;
  processStartIdentity: string;
};

/** Mirrors readLinuxProcessIdentity in src/manager/acpx.ts. */
async function readProcIdentity(pid: number): Promise<LiveTurnProcess> {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = raw.lastIndexOf(")");
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/u);
  const processGroupId = Number.parseInt(fields[2] ?? "", 10);
  const startTicks = fields[19];
  if (!Number.isFinite(processGroupId) || startTicks == null) {
    throw new Error(`Unable to read process identity for pid ${pid}.`);
  }
  return {
    pid,
    processGroupId,
    processStartIdentity: `${pid}:${startTicks}`
  };
}

function baseSession(name: string, workspaceDir: string): SessionInfo {
  return {
    name,
    agent: "claude",
    directory: workspaceDir,
    state: "idle",
    createdAt: T_CREATED,
    lastActivity: T_LAST_ACTIVITY,
    permissionMode: "approve-reads",
    warnings: [],
    transcript: [
      { role: "user", text: `Task for ${name} scenario.`, createdAt: T_USER },
      { role: "assistant", text: `Answer for ${name} scenario.`, createdAt: T_ASSISTANT }
    ]
  };
}

function buildScenarioSessions(
  workspaceDir: string,
  liveTurn: LiveTurnProcess
): Record<ContractScenario, SessionInfo> {
  return {
    idle: baseSession("idle", workspaceDir),
    running: {
      ...baseSession("running", workspaceDir),
      state: "running",
      transcript: [
        { role: "user", text: "Task for running scenario.", createdAt: T_USER },
        { role: "assistant", text: "Answer for running scenario.", createdAt: T_ASSISTANT }
      ],
      activeTurn: {
        id: "turn-running-1",
        state: "running",
        startedAt: T_TURN_STARTED,
        updatedAt: T_TURN_OUTPUT,
        pid: liveTurn.pid,
        processGroupId: liveTurn.processGroupId,
        processStartIdentity: liveTurn.processStartIdentity,
        lastOutputAt: T_TURN_OUTPUT,
        outputChars: 42
      }
    },
    orphaned: {
      ...baseSession("orphaned", workspaceDir),
      state: "running",
      activeTurn: {
        id: "turn-orphaned-1",
        state: "running",
        startedAt: T_TURN_STARTED,
        updatedAt: T_TURN_OUTPUT,
        pid: DEAD_PID,
        processGroupId: DEAD_PID,
        processStartIdentity: `${DEAD_PID}:1`,
        lastOutputAt: T_TURN_OUTPUT,
        outputChars: 7
      }
    },
    "legacy-no-turn": {
      ...baseSession("legacy-no-turn", workspaceDir),
      state: "running"
    },
    failed: {
      ...baseSession("failed", workspaceDir),
      state: "failed",
      lastError: "Simulated turn failure",
      activeTurn: {
        id: "turn-failed-1",
        state: "failed",
        startedAt: T_TURN_STARTED,
        updatedAt: T_TURN_OUTPUT,
        completedAt: T_TURN_OUTPUT,
        outputChars: 0,
        exitCode: 1,
        error: "Simulated turn failure"
      }
    },
    quiesced: {
      ...baseSession("quiesced", workspaceDir),
      state: "stopped",
      lastStopReason: "quiesced at lifecycle epoch 1"
    }
  };
}

function sanitizeBody(
  body: string,
  workspaceDir: string,
  liveTurn: LiveTurnProcess
): unknown {
  const sanitized = body
    .replaceAll(liveTurn.processStartIdentity, FIXED_PROCESS_START_IDENTITY)
    .replace(new RegExp(`\\b${liveTurn.pid}\\b`, "gu"), String(FIXED_PID))
    .replace(
      new RegExp(`\\b${liveTurn.processGroupId}\\b`, "gu"),
      String(FIXED_PROCESS_GROUP_ID)
    )
    .replaceAll(workspaceDir, FIXED_WORKSPACE)
    .replace(/(\\?"detectedAt\\?":\s*\\?")[^"\\]+(\\?")/gu, `$1${T_LAST_ACTIVITY}$2`)
    .replace(/(\\?"ageMs\\?":\s*)\d+/gu, `$1${FIXED_AGE_MS}`)
    .replace(/(\\?"outputAgeMs\\?":\s*)\d+/gu, `$1${FIXED_OUTPUT_AGE_MS}`);
  return JSON.parse(sanitized);
}

export async function generateContractFixtures(): Promise<
  Record<ContractScenario, ContractCapture>
> {
  if (process.platform !== "linux") {
    throw new Error("Contract fixture generation requires Linux process identity probing.");
  }
  const rootDir = await mkdtemp(join(tmpdir(), "puppenclaw-contract-"));
  const workspaceDir = join(rootDir, "workspace");
  const dataDir = join(rootDir, "daemon");
  const liveChild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    stdio: "ignore",
    detached: true
  });
  try {
    if (liveChild.pid == null) {
      throw new Error("Unable to spawn the live turn placeholder process.");
    }
    const liveTurn = await readProcIdentity(liveChild.pid);
    const sessions = buildScenarioSessions(workspaceDir, liveTurn);

    const storedState: StoredState = {
      version: SESSION_STORE_VERSION,
      sessions: Object.fromEntries(
        Object.values(sessions).map((session) => [session.name, session])
      ),
      exposures: {},
      quiescence: {
        lastEpoch: 1,
        active: {
          quiesced: {
            name: "quiesced",
            epoch: 1,
            purpose: "external",
            updatedAt: T_LAST_ACTIVITY
          }
        },
        latestByName: { quiesced: 1 }
      }
    };
    await writeJsonFileAtomic(join(dataDir, "state.json"), storedState);

    // Fake acpx runtime markers: the idle and running sessions have a live
    // persistent ACP runtime; every other scenario reports no runtime.
    const fakeStateDir = join(workspaceDir, ".fake-acpx-state");
    await mkdir(fakeStateDir, { recursive: true });
    for (const name of ["idle", "running"]) {
      await writeFile(join(fakeStateDir, `${name}.session`), "alive\nclaude\n", "utf8");
    }

    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() }),
      dataDir,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      }
    });
    try {
      const captures = {} as Record<ContractScenario, ContractCapture>;
      for (const scenario of CONTRACT_SCENARIOS) {
        const statusResponse = await app.inject({
          method: "GET",
          url: `/session/${scenario}`
        });
        const outputResponse = await app.inject({
          method: "GET",
          url: `/session/${scenario}/output`
        });
        if (statusResponse.statusCode !== 200 || outputResponse.statusCode !== 200) {
          throw new Error(
            `Scenario ${scenario} returned HTTP ${statusResponse.statusCode}/${outputResponse.statusCode}.`
          );
        }
        captures[scenario] = {
          status: sanitizeBody(statusResponse.body, workspaceDir, liveTurn),
          output: sanitizeBody(outputResponse.body, workspaceDir, liveTurn)
        };
      }
      return captures;
    } finally {
      await app.close();
    }
  } finally {
    liveChild.kill("SIGKILL");
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fixtures = await generateContractFixtures();
  await mkdir(CONTRACT_FIXTURES_DIR, { recursive: true });
  for (const scenario of CONTRACT_SCENARIOS) {
    const capture = fixtures[scenario];
    await writeFile(
      join(CONTRACT_FIXTURES_DIR, `${scenario}.status.json`),
      `${JSON.stringify(capture.status, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      join(CONTRACT_FIXTURES_DIR, `${scenario}.output.json`),
      `${JSON.stringify(capture.output, null, 2)}\n`,
      "utf8"
    );
    console.info(`Wrote ${scenario}.status.json and ${scenario}.output.json`);
  }
}

if (
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
