import { join } from "node:path";

import { REMOTE_CONTROL_VERBS, SESSION_STORE_VERSION } from "./schema.js";
import { PuppenclawError } from "./errors.js";
import type {
  ExposureRecord,
  SessionInfo,
  SessionQuiescenceReservation,
  StoredState
} from "./types.js";
import { nowIso, readJsonFile, writeJsonFileAtomic } from "./utils.js";

export class SessionStore {
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    readonly rootDir: string,
    private state: StoredState
  ) {}

  static async open(rootDir: string): Promise<SessionStore> {
    const statePath = join(rootDir, "state.json");
    const state = await readJsonFile<StoredState>(statePath, {
      version: SESSION_STORE_VERSION,
      sessions: {},
      exposures: {},
      quiescence: { lastEpoch: 0, active: {} }
    });
    return new SessionStore(
      rootDir,
      state.version === SESSION_STORE_VERSION
        ? {
            version: SESSION_STORE_VERSION,
            sessions: state.sessions ?? {},
            exposures: state.exposures ?? {},
            quiescence: normalizeQuiescenceState(state.quiescence)
          }
        : {
            version: SESSION_STORE_VERSION,
            sessions: {},
            exposures: {},
            quiescence: { lastEpoch: 0, active: {} }
          }
    );
  }

  get statePath(): string {
    return join(this.rootDir, "state.json");
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

  assertSessionMutable(name: string): void {
    assertSessionMutable(this.state, name);
  }

  async reserveQuiescence(
    name: string,
    purpose: "external" | "purge"
  ): Promise<SessionQuiescenceReservation> {
    return await this.mutate((state) => {
      const current = state.quiescence.active[name];
      if (current != null) {
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
      return next;
    });
  }

  async releaseQuiescence(name: string, epoch: number): Promise<SessionQuiescenceReservation> {
    return await this.mutate((state) => {
      const current = state.quiescence.active[name];
      if (current == null) {
        if (Number.isSafeInteger(epoch) && epoch > 0 && epoch <= state.quiescence.lastEpoch) {
          return {
            name,
            epoch,
            purpose: "external",
            updatedAt: nowIso()
          };
        }
        throw staleQuiescenceEpoch(name, epoch, undefined, state.quiescence.lastEpoch);
      }
      if (current.epoch !== epoch) {
        throw staleQuiescenceEpoch(name, epoch, current, state.quiescence.lastEpoch);
      }
      delete state.quiescence.active[name];
      return current;
    });
  }

  async flush(): Promise<void> {
    await this.mutate(() => undefined);
  }

  private async mutate<T>(mutator: (state: StoredState) => T): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const nextState = structuredClone(this.state);
      const result = mutator(nextState);
      await writeJsonFileAtomic(this.statePath, nextState);
      this.state = nextState;
      return result;
    });
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined
    );
    return await operation;
  }
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
  lastEpoch: number
): PuppenclawError {
  return new PuppenclawError(
    "STALE_QUIESCENCE_EPOCH",
    `Quiescence epoch ${epoch} is not active for session ${name}.`,
    {
      name,
      requestedEpoch: epoch,
      activeEpoch: current?.epoch ?? null,
      lastEpoch
    }
  );
}

function normalizeQuiescenceState(value: unknown): StoredState["quiescence"] {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { lastEpoch: 0, active: {} };
  }
  const candidate = value as Partial<StoredState["quiescence"]>;
  return {
    lastEpoch:
      Number.isSafeInteger(candidate.lastEpoch) && (candidate.lastEpoch ?? 0) >= 0
        ? (candidate.lastEpoch ?? 0)
        : 0,
    active: candidate.active != null && typeof candidate.active === "object" ? candidate.active : {}
  };
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
