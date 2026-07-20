import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { ensureDir } from "../shared/utils.js";
import { computeJobRecordZod, type ComputeJobRecord } from "./types.js";

const NODE_SQLITE_SPECIFIER = `node${":sqlite"}`;

export class ComputeStore {
  private constructor(
    private readonly db: DatabaseSyncType,
    readonly rootDir: string
  ) {}

  static async open(rootDir: string): Promise<ComputeStore> {
    await ensureDir(rootDir);
    const { DatabaseSync } = await import(NODE_SQLITE_SPECIFIER);
    const db = new DatabaseSync(join(rootDir, "compute.sqlite"));
    const store = new ComputeStore(db, rootDir);
    store.migrate();
    return store;
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS compute_jobs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compute_jobs_state
        ON compute_jobs(state, submitted_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  get(id: string): ComputeJobRecord | null {
    const row = this.db.prepare("SELECT payload FROM compute_jobs WHERE id = ?").get(id) as
      | { payload: string }
      | undefined;
    return row == null ? null : computeJobRecordZod.parse(JSON.parse(row.payload));
  }

  listActive(): ComputeJobRecord[] {
    return this.db
      .prepare(
        "SELECT payload FROM compute_jobs WHERE state IN ('queued','starting','running') ORDER BY submitted_at"
      )
      .all()
      .map((row) =>
        computeJobRecordZod.parse(JSON.parse((row as { payload: string }).payload))
      );
  }

  upsert(record: ComputeJobRecord): void {
    const parsed = computeJobRecordZod.parse(record);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO compute_jobs (id, state, submitted_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           updated_at = excluded.updated_at,
           payload = excluded.payload`
      )
      .run(parsed.id, parsed.state, parsed.submittedAt, now, JSON.stringify(parsed));
  }
}

