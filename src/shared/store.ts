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
      quiescence: { lastEpoch: 0, active: {}, latestByName: {} }
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
            quiescence: { lastEpoch: 0, active: {}, latestByName: {} }
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

function normalizeQuiescenceState(value: unknown): StoredState["quiescence"] {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { lastEpoch: 0, active: {}, latestByName: {} };
  }
  const candidate = value as Partial<StoredState["quiescence"]>;
  const active =
    candidate.active != null && typeof candidate.active === "object" ? candidate.active : {};
  const latestByName =
    candidate.latestByName != null && typeof candidate.latestByName === "object"
      ? Object.fromEntries(
          Object.entries(candidate.latestByName).filter(
            (entry): entry is [string, number] =>
              Number.isSafeInteger(entry[1]) && entry[1] > 0
          )
        )
      : {};
  for (const [name, reservation] of Object.entries(active)) {
    if (
      reservation != null &&
      reservation.purpose !== "purge" &&
      Number.isSafeInteger(reservation.epoch) &&
      reservation.epoch > (latestByName[name] ?? 0)
    ) {
      latestByName[name] = reservation.epoch;
    }
  }
  return {
    lastEpoch:
      Number.isSafeInteger(candidate.lastEpoch) && (candidate.lastEpoch ?? 0) >= 0
        ? (candidate.lastEpoch ?? 0)
        : 0,
    active,
    latestByName
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
