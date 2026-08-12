import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import {
  agentKindZod,
  effortLevelZod,
  exposureModeZod,
  modelProviderConfigZod,
  permissionModeZod,
  planningProfileZod,
  REMOTE_CONTROL_VERBS,
  remoteVerbZod,
  SESSION_STORE_VERSION
} from "./schema.js";
import { PuppenclawError } from "./errors.js";
import type {
  ExposureRecord,
  SessionInfo,
  SessionQuiescenceReservation,
  StateRecoveryStatus,
  StoredState
} from "./types.js";
import { ensureDir, nowIso, quarantineFile, writeJsonFileAtomic } from "./utils.js";

const OWNER_LEASE_VERSION = 1 as const;
const OWNER_LEASE_FILE = ".state-owner.json";

const transcriptEntryZod = z
  .object({
    role: z.enum(["system", "user", "assistant", "status"]),
    text: z.string(),
    createdAt: z.string().min(1)
  })
  .strict();

const activeTurnZod = z
  .object({
    id: z.string().min(1),
    state: z.enum(["running", "completed", "failed", "stopped", "orphaned"]),
    startedAt: z.string().min(1),
    updatedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
    pid: z.number().int().positive().optional(),
    processGroupId: z.number().int().positive().optional(),
    processStartIdentity: z.string().min(1).optional(),
    lastOutputAt: z.string().min(1).optional(),
    outputChars: z.number().int().nonnegative(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    error: z.string().optional()
  })
  .strict();

const tokenUsageZod = z
  .object({
    used: z.number().finite().nonnegative().optional(),
    size: z.number().finite().nonnegative().optional(),
    input: z.number().finite().nonnegative().optional(),
    output: z.number().finite().nonnegative().optional(),
    cacheRead: z.number().finite().nonnegative().optional(),
    cacheWrite: z.number().finite().nonnegative().optional(),
    cached: z.number().finite().nonnegative().optional()
  })
  .strict();

const conversationScopeZod = z
  .object({
    channel: z.string(),
    accountId: z.string(),
    conversationId: z.string(),
    parentConversationId: z.string().optional(),
    threadId: z.union([z.string(), z.number()]).optional()
  })
  .strict();

const sessionSourceZod = z
  .object({
    kind: z.enum(["tool", "command", "daemon"]),
    channel: z.string().optional(),
    requesterSenderId: z.string().optional(),
    bindingId: z.string().optional()
  })
  .strict();

const sessionInfoZod = z
  .object({
    name: z.string().min(1),
    agent: agentKindZod,
    directory: z.string().min(1),
    state: z.enum(["idle", "running", "waiting_input", "suspended", "completed", "failed", "stopped"]),
    createdAt: z.string().min(1),
    lastActivity: z.string().min(1),
    focusedUntil: z.string().min(1).optional(),
    permissionMode: permissionModeZod,
    effort: effortLevelZod.optional(),
    effectiveEffort: effortLevelZod.optional(),
    runtimeEffort: effortLevelZod.optional(),
    reasoningProfile: z.enum(["claude", "codex", "glm-5.2"]).optional(),
    planningProfile: planningProfileZod.optional(),
    model: z.string().min(1).optional(),
    modelProviderId: z.string().min(1).optional(),
    modelProvider: modelProviderConfigZod.optional(),
    skills: z.array(z.string().min(1)).optional(),
    tokenUsage: tokenUsageZod.optional(),
    pendingQuestion: z.string().optional(),
    lastError: z.string().optional(),
    warnings: z.array(z.string()),
    transcript: z.array(transcriptEntryZod),
    handle: z
      .object({
        runtimeSessionName: z.string().min(1),
        cwd: z.string().min(1),
        agent: agentKindZod,
        mode: z.literal("persistent")
      })
      .strict()
      .optional(),
    lastStopReason: z.string().optional(),
    activeTurn: activeTurnZod.optional(),
    source: sessionSourceZod.optional(),
    origin: conversationScopeZod.optional()
  })
  .strict();

const exposureRecordZod = z
  .object({
    bindingId: z.string().min(1),
    conversation: conversationScopeZod,
    allowPurePipe: z.boolean(),
    allowedAgents: z.array(agentKindZod),
    mode: exposureModeZod,
    allowedVerbs: z.array(remoteVerbZod),
    allowedProjectRoots: z.array(z.string()),
    updatedAt: z.string().min(1)
  })
  .strict();

const quiescenceReservationZod = z
  .object({
    name: z.string().min(1),
    epoch: z.number().int().positive(),
    purpose: z.enum(["external", "purge"]),
    updatedAt: z.string().min(1)
  })
  .strict();

const storedStateZod = z
  .object({
    version: z.literal(SESSION_STORE_VERSION),
    sessions: z.record(z.string(), sessionInfoZod),
    exposures: z.record(z.string(), exposureRecordZod),
    quiescence: z
      .object({
        lastEpoch: z.number().int().nonnegative(),
        active: z.record(z.string(), quiescenceReservationZod),
        latestByName: z.record(z.string(), z.number().int().positive())
      })
      .strict()
  })
  .strict();

const ownerLeaseZod = z
  .object({
    version: z.literal(OWNER_LEASE_VERSION),
    ownerId: z.string().min(1),
    pid: z.number().int().positive(),
    processStartIdentity: z.string().min(1).optional(),
    acquiredAt: z.string().min(1)
  })
  .strict();

type OwnerLease = z.infer<typeof ownerLeaseZod>;

function freshState(): StoredState {
  return {
    version: SESSION_STORE_VERSION,
    sessions: {},
    exposures: {},
    quiescence: { lastEpoch: 0, active: {}, latestByName: {} }
  };
}

export class SessionStore {
  private mutationTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    readonly rootDir: string,
    private state: StoredState,
    private recovery: StateRecoveryStatus,
    private readonly ownerLease: OwnerLease
  ) {}

  static async open(rootDir: string): Promise<SessionStore> {
    const ownerLease = await acquireOwnerLease(rootDir);
    try {
      const loaded = await loadStoredState(join(rootDir, "state.json"));
      return new SessionStore(rootDir, loaded.state, loaded.recovery, ownerLease);
    } catch (error) {
      await releaseOwnerLease(rootDir, ownerLease);
      throw error;
    }
  }

  get statePath(): string {
    return join(this.rootDir, "state.json");
  }

  get ownerLeasePath(): string {
    return join(this.rootDir, OWNER_LEASE_FILE);
  }

  getRecoveryStatus(): StateRecoveryStatus {
    return structuredClone(this.recovery);
  }

  async resetRecovery(): Promise<StateRecoveryStatus> {
    if (!this.recovery.required) {
      return { required: false };
    }
    await this.enqueueMutation(async () => {
      const nextState = freshState();
      await writeJsonFileAtomic(this.statePath, nextState);
      this.state = nextState;
      this.recovery = { required: false };
    });
    return { required: false };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.mutationTail.catch(() => undefined);
    await releaseOwnerLease(this.rootDir, this.ownerLease);
  }

  listSessions(): SessionInfo[] {
    return Object.values(this.state.sessions).sort((left, right) =>
      right.lastActivity.localeCompare(left.lastActivity)
    );
  }

  getSession(name: string): SessionInfo | null {
    return this.state.sessions[name] ?? null;
  }

  async upsertSession(session: SessionInfo): Promise<void> {
    await this.mutate((state) => {
      assertSessionMutable(state, session.name);
      state.sessions[session.name] = session;
    });
  }

  async patchSession(
    name: string,
    patch: (current: SessionInfo | null) => SessionInfo | null
  ): Promise<SessionInfo | null> {
    return await this.mutate((state) => {
      assertSessionMutable(state, name);
      const next = patch(state.sessions[name] ?? null);
      if (next == null) {
        delete state.sessions[name];
      } else {
        state.sessions[name] = next;
      }
      return next;
    });
  }

  async patchQuiescedSession(
    name: string,
    epoch: number,
    patch: (current: SessionInfo) => SessionInfo
  ): Promise<SessionInfo | null> {
    return await this.mutate((state) => {
      const reservation = state.quiescence.active[name];
      if (reservation?.epoch !== epoch) {
        throw staleQuiescenceEpoch(
          name,
          epoch,
          reservation,
          state.quiescence.latestByName[name],
          state.quiescence.lastEpoch
        );
      }
      const current = state.sessions[name];
      if (current == null) {
        return null;
      }
      const next = patch(current);
      state.sessions[name] = next;
      return next;
    });
  }

  async removeSession(name: string): Promise<boolean> {
    return await this.mutate((state) => {
      if (!(name in state.sessions)) {
        return false;
      }
      delete state.sessions[name];
      return true;
    });
  }

  getExposure(bindingId: string): ExposureRecord | null {
    const exposure = this.state.exposures[bindingId];
    return exposure != null ? normalizeExposureRecord(exposure) : null;
  }

  listExposures(): ExposureRecord[] {
    return Object.values(this.state.exposures)
      .map((exposure) => normalizeExposureRecord(exposure))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async upsertExposure(exposure: ExposureRecord): Promise<void> {
    await this.mutate((state) => {
      state.exposures[exposure.bindingId] = normalizeExposureRecord({
        ...exposure,
        updatedAt: exposure.updatedAt || nowIso()
      });
    });
  }

  async removeExposure(bindingId: string): Promise<boolean> {
    return await this.mutate((state) => {
      if (!(bindingId in state.exposures)) {
        return false;
      }
      delete state.exposures[bindingId];
      return true;
    });
  }

  getQuiescence(name: string): SessionQuiescenceReservation | null {
    return this.state.quiescence.active[name] ?? null;
  }

  getActiveQuiescenceEpoch(name: string): number | null {
    return this.state.quiescence.active[name]?.epoch ?? null;
  }

  getLatestLifecycleEpoch(name: string): number | null {
    return this.state.quiescence.latestByName[name] ?? null;
  }

  assertSessionMutable(name: string): void {
    this.assertWritable();
    assertSessionMutable(this.state, name);
  }

  async reserveQuiescence(
    name: string,
    purpose: "external" | "purge"
  ): Promise<SessionQuiescenceReservation> {
    return await this.mutate((state) => {
      const current = state.quiescence.active[name];
      if (current != null) {
        if (purpose === "external" && current.purpose === "purge") {
          const promoted: SessionQuiescenceReservation = {
            ...current,
            purpose: "external",
            updatedAt: nowIso()
          };
          state.quiescence.active[name] = promoted;
          state.quiescence.latestByName[name] = promoted.epoch;
          return promoted;
        }
        return current;
      }
      const lastEpoch = state.quiescence.lastEpoch;
      if (!Number.isSafeInteger(lastEpoch) || lastEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new PuppenclawError(
          "QUIESCENCE_EPOCH_EXHAUSTED",
          `Session ${name} cannot allocate another quiescence epoch.`
        );
      }
      const epoch = lastEpoch + 1;
      const next: SessionQuiescenceReservation = {
        name,
        epoch,
        purpose,
        updatedAt: nowIso()
      };
      state.quiescence.lastEpoch = epoch;
      state.quiescence.active[name] = next;
      if (purpose === "external") {
        state.quiescence.latestByName[name] = epoch;
      }
      return next;
    });
  }

  async releaseQuiescence(name: string, epoch: number): Promise<SessionQuiescenceReservation> {
    return await this.mutate((state) => {
      const current = state.quiescence.active[name];
      const latestEpoch = state.quiescence.latestByName[name];
      if (current == null) {
        if (latestEpoch === epoch) {
          return {
            name,
            epoch,
            purpose: "external",
            updatedAt: nowIso()
          };
        }
        throw staleQuiescenceEpoch(name, epoch, undefined, latestEpoch, state.quiescence.lastEpoch);
      }
      if (current.epoch !== epoch) {
        throw staleQuiescenceEpoch(name, epoch, current, latestEpoch, state.quiescence.lastEpoch);
      }
      delete state.quiescence.active[name];
      return current;
    });
  }

  async enterLifecycleTurn(name: string, requestedEpoch?: number): Promise<{
    lifecycleEpoch: number | null;
    releasedQuiescence: boolean;
  }> {
    return await this.mutate((state) => {
      const latestEpoch = state.quiescence.latestByName[name];
      const activeReservation = state.quiescence.active[name];
      if (activeReservation?.purpose === "purge") {
        throw new PuppenclawError(
          "SESSION_QUIESCED",
          `Session ${name} is fenced by transient purge epoch ${activeReservation.epoch}.`,
          {
            name,
            quiescenceEpoch: activeReservation.epoch,
            latestEpoch: latestEpoch ?? null,
            lastEpoch: state.quiescence.lastEpoch
          }
        );
      }
      if (latestEpoch == null) {
        if (requestedEpoch != null) {
          throw staleLifecycleEpoch(name, requestedEpoch, undefined, state.quiescence.lastEpoch);
        }
        return { lifecycleEpoch: null, releasedQuiescence: false };
      }
      if (requestedEpoch == null) {
        const activeEpoch = state.quiescence.active[name]?.epoch;
        if (activeEpoch != null) {
          throw new PuppenclawError(
            "SESSION_QUIESCED",
            `Session ${name} is fenced by quiescence epoch ${activeEpoch}.`,
            { name, quiescenceEpoch: activeEpoch, latestEpoch, lastEpoch: state.quiescence.lastEpoch }
          );
        }
        throw new PuppenclawError(
          "LIFECYCLE_EPOCH_REQUIRED",
          `Session ${name} requires lifecycle epoch ${latestEpoch} before another turn can start.`,
          {
            name,
            requestedEpoch: null,
            activeEpoch: state.quiescence.active[name]?.epoch ?? null,
            latestEpoch,
            lastEpoch: state.quiescence.lastEpoch
          }
        );
      }
      if (requestedEpoch !== latestEpoch) {
        throw staleLifecycleEpoch(name, requestedEpoch, latestEpoch, state.quiescence.lastEpoch);
      }
      const current = state.quiescence.active[name];
      if (current != null && current.epoch !== requestedEpoch) {
        throw staleQuiescenceEpoch(
          name,
          requestedEpoch,
          current,
          latestEpoch,
          state.quiescence.lastEpoch
        );
      }
      if (current != null) {
        delete state.quiescence.active[name];
      }
      return {
        lifecycleEpoch: latestEpoch,
        releasedQuiescence: current != null
      };
    });
  }

  async flush(): Promise<void> {
    this.assertWritable();
    await this.mutate(() => undefined);
  }

  private async mutate<T>(mutator: (state: StoredState) => T): Promise<T> {
    this.assertWritable();
    return await this.enqueueMutation(async () => {
      const nextState = structuredClone(this.state);
      const result = mutator(nextState);
      await writeJsonFileAtomic(this.statePath, nextState);
      this.state = nextState;
      return result;
    });
  }

  private async enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new PuppenclawError("STATE_STORE_CLOSED", "Session store is closed.");
    }
    const operation = this.mutationTail.then(run);
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined
    );
    return await operation;
  }

  private assertWritable(): void {
    if (this.closed) {
      throw new PuppenclawError("STATE_STORE_CLOSED", "Session store is closed.");
    }
    if (!this.recovery.required) {
      return;
    }
    throw new PuppenclawError(
      "STATE_RECOVERY_REQUIRED",
      `Session state is read-only until an operator reset is performed: ${this.recovery.message}`,
      this.recovery
    );
  }
}

async function loadStoredState(statePath: string): Promise<{
  state: StoredState;
  recovery: StateRecoveryStatus;
}> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { state: freshState(), recovery: { required: false } };
    }
    return await recoveryState({
      statePath,
      reason: "unreadable",
      message: `Unable to read persisted session state: ${errorMessage(error)}`,
      quarantine: false
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return await recoveryState({
      statePath,
      reason: "corrupt",
      message: `Persisted session state is not valid JSON: ${errorMessage(error)}`,
      quarantine: true
    });
  }

  const validated = storedStateZod.safeParse(upgradeCompatibleState(parsed));
  if (validated.success) {
    return {
      state: validated.data as unknown as StoredState,
      recovery: { required: false }
    };
  }
  const version =
    parsed != null && typeof parsed === "object" && !Array.isArray(parsed) && "version" in parsed
      ? (parsed as { version?: unknown }).version
      : undefined;
  const incompatible = version !== SESSION_STORE_VERSION;
  return await recoveryState({
    statePath,
    reason: incompatible ? "incompatible" : "invalid",
    message: incompatible
      ? `Persisted session state version ${String(version)} is incompatible with required version ${SESSION_STORE_VERSION}.`
      : `Persisted session state failed validation: ${z.prettifyError(validated.error)}`,
    quarantine: true
  });
}

function upgradeCompatibleState(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const state = value as Record<string, unknown>;
  const rawQuiescence = state.quiescence;
  if (
    rawQuiescence == null ||
    typeof rawQuiescence !== "object" ||
    Array.isArray(rawQuiescence) ||
    "latestByName" in rawQuiescence
  ) {
    return value;
  }
  const quiescence = rawQuiescence as Record<string, unknown>;
  const active =
    quiescence.active != null &&
    typeof quiescence.active === "object" &&
    !Array.isArray(quiescence.active)
      ? (quiescence.active as Record<string, unknown>)
      : {};
  const latestByName: Record<string, number> = {};
  for (const [name, rawReservation] of Object.entries(active)) {
    if (
      rawReservation != null &&
      typeof rawReservation === "object" &&
      !Array.isArray(rawReservation)
    ) {
      const reservation = rawReservation as Record<string, unknown>;
      if (
        reservation.purpose === "external" &&
        typeof reservation.epoch === "number" &&
        Number.isSafeInteger(reservation.epoch) &&
        reservation.epoch > 0
      ) {
        latestByName[name] = reservation.epoch;
      }
    }
  }
  return {
    ...state,
    quiescence: {
      ...quiescence,
      latestByName
    }
  };
}

async function recoveryState(params: {
  statePath: string;
  reason: Extract<StateRecoveryStatus, { required: true }>['reason'];
  message: string;
  quarantine: boolean;
}): Promise<{ state: StoredState; recovery: StateRecoveryStatus }> {
  const quarantinePath = params.quarantine ? await quarantineFile(params.statePath) : null;
  const detectedAt = nowIso();
  const recovery: StateRecoveryStatus = {
    required: true,
    reason: params.reason,
    message: params.message,
    detectedAt,
    ...(quarantinePath != null ? { quarantinePath } : {})
  };
  console.error(
    `${params.message} The store is in recovery-required read-only mode${
      quarantinePath != null ? `; previous state was preserved at ${quarantinePath}` : ""
    }.`
  );
  return { state: freshState(), recovery };
}

async function acquireOwnerLease(rootDir: string): Promise<OwnerLease> {
  await ensureDir(rootDir);
  const leasePath = join(rootDir, OWNER_LEASE_FILE);
  const lease: OwnerLease = {
    version: OWNER_LEASE_VERSION,
    ownerId: randomUUID(),
    pid: process.pid,
    ...(await currentProcessStartIdentity()),
    acquiredAt: nowIso()
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await writeOwnerLeaseExclusive(leasePath, lease);
      return lease;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw new PuppenclawError(
          "STATE_OWNER_LEASE_FAILED",
          `Unable to acquire the session-state owner lease at ${leasePath}: ${errorMessage(error)}`
        );
      }
    }

    const existing = await readOwnerLease(leasePath);
    if (existing == null) {
      throw new PuppenclawError(
        "STATE_ROOT_IN_USE",
        `The session-state owner lease at ${leasePath} is unreadable; refusing to assume ownership.`
      );
    }
    if (await ownerLeaseMayBeLive(existing)) {
      throw new PuppenclawError(
        "STATE_ROOT_IN_USE",
        `Session state at ${rootDir} is already owned by process ${existing.pid}.`,
        { pid: existing.pid, acquiredAt: existing.acquiredAt }
      );
    }

    const stalePath = `${leasePath}.stale-${nowIso().replaceAll(":", "-")}-${randomUUID()}`;
    try {
      await rename(leasePath, stalePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      throw new PuppenclawError(
        "STATE_OWNER_LEASE_FAILED",
        `Unable to preserve stale session-state owner lease at ${leasePath}: ${errorMessage(error)}`
      );
    }
  }
  throw new PuppenclawError(
    "STATE_ROOT_IN_USE",
    `Session state at ${rootDir} changed ownership repeatedly; refusing to open it.`
  );
}

async function writeOwnerLeaseExclusive(path: string, lease: OwnerLease): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function readOwnerLease(path: string): Promise<OwnerLease | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const result = ownerLeaseZod.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function ownerLeaseMayBeLive(lease: OwnerLease): Promise<boolean> {
  try {
    process.kill(lease.pid, 0);
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
  if (process.platform !== "linux" || lease.processStartIdentity == null) {
    return true;
  }
  const current = await linuxProcessStartIdentity(lease.pid);
  return current == null || current === lease.processStartIdentity;
}

async function currentProcessStartIdentity(): Promise<{ processStartIdentity?: string }> {
  const identity = await linuxProcessStartIdentity(process.pid);
  return identity != null ? { processStartIdentity: identity } : {};
}

async function linuxProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform !== "linux") {
    return null;
  }
  const raw = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (raw == null) {
    return null;
  }
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd < 0) {
    return null;
  }
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/u);
  const startTicks = fields[19];
  return startTicks != null ? `${pid}:${startTicks}` : null;
}

async function releaseOwnerLease(rootDir: string, lease: OwnerLease): Promise<void> {
  const path = join(rootDir, OWNER_LEASE_FILE);
  const current = await readOwnerLease(path);
  if (current?.ownerId !== lease.ownerId) {
    return;
  }
  await unlink(path).catch((error) => {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  });
  await syncDirectory(rootDir);
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the lease file itself
    // is still fsynced before it is considered acquired.
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertSessionMutable(state: StoredState, name: string): void {
  const epoch = state.quiescence.active[name]?.epoch;
  if (epoch == null) {
    return;
  }
  throw new PuppenclawError(
    "SESSION_QUIESCED",
    `Session ${name} is fenced by quiescence epoch ${epoch}.`,
    { name, quiescenceEpoch: epoch }
  );
}

function staleQuiescenceEpoch(
  name: string,
  epoch: number,
  current: SessionQuiescenceReservation | undefined,
  latestEpoch: number | undefined,
  lastEpoch: number
): PuppenclawError {
  return new PuppenclawError(
    "STALE_QUIESCENCE_EPOCH",
    `Quiescence epoch ${epoch} is not active for session ${name}.`,
    {
      name,
      requestedEpoch: epoch,
      activeEpoch: current?.epoch ?? null,
      latestEpoch: latestEpoch ?? null,
      lastEpoch
    }
  );
}

function staleLifecycleEpoch(
  name: string,
  requestedEpoch: number,
  latestEpoch: number | undefined,
  lastEpoch: number
): PuppenclawError {
  return new PuppenclawError(
    "STALE_LIFECYCLE_EPOCH",
    `Lifecycle epoch ${requestedEpoch} is not current for session ${name}.`,
    {
      name,
      requestedEpoch,
      activeEpoch: null,
      latestEpoch: latestEpoch ?? null,
      lastEpoch
    }
  );
}

function normalizeExposureRecord(
  exposure: Partial<ExposureRecord> & Pick<ExposureRecord, "bindingId" | "conversation">
): ExposureRecord {
  return {
    bindingId: exposure.bindingId,
    conversation: exposure.conversation,
    allowPurePipe: exposure.allowPurePipe ?? false,
    allowedAgents: exposure.allowedAgents ?? ["claude", "codex"],
    mode: exposure.mode ?? "execute",
    allowedVerbs: exposure.allowedVerbs ?? [...REMOTE_CONTROL_VERBS],
    allowedProjectRoots: exposure.allowedProjectRoots ?? [],
    updatedAt: exposure.updatedAt ?? nowIso()
  };
}
