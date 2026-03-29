import { join } from "node:path";

import { SESSION_STORE_VERSION } from "./schema.js";
import type { ExposureRecord, SessionInfo, StoredState } from "./types.js";
import { nowIso, readJsonFile, writeJsonFileAtomic } from "./utils.js";

export class SessionStore {
  private constructor(
    readonly rootDir: string,
    private state: StoredState
  ) {}

  static async open(rootDir: string): Promise<SessionStore> {
    const statePath = join(rootDir, "state.json");
    const state = await readJsonFile<StoredState>(statePath, {
      version: SESSION_STORE_VERSION,
      sessions: {},
      exposures: {}
    });
    return new SessionStore(rootDir, state.version === SESSION_STORE_VERSION ? state : {
      version: SESSION_STORE_VERSION,
      sessions: {},
      exposures: {}
    });
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
    this.state.sessions[session.name] = session;
    await this.flush();
  }

  async patchSession(
    name: string,
    patch: (current: SessionInfo | null) => SessionInfo | null
  ): Promise<SessionInfo | null> {
    const next = patch(this.getSession(name));
    if (next == null) {
      delete this.state.sessions[name];
    } else {
      this.state.sessions[name] = next;
    }
    await this.flush();
    return next;
  }

  async removeSession(name: string): Promise<boolean> {
    if (!(name in this.state.sessions)) {
      return false;
    }
    delete this.state.sessions[name];
    await this.flush();
    return true;
  }

  getExposure(bindingId: string): ExposureRecord | null {
    return this.state.exposures[bindingId] ?? null;
  }

  listExposures(): ExposureRecord[] {
    return Object.values(this.state.exposures).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
  }

  async upsertExposure(exposure: ExposureRecord): Promise<void> {
    this.state.exposures[exposure.bindingId] = {
      ...exposure,
      updatedAt: exposure.updatedAt || nowIso()
    };
    await this.flush();
  }

  async removeExposure(bindingId: string): Promise<boolean> {
    if (!(bindingId in this.state.exposures)) {
      return false;
    }
    delete this.state.exposures[bindingId];
    await this.flush();
    return true;
  }

  async flush(): Promise<void> {
    await writeJsonFileAtomic(this.statePath, this.state);
  }
}
