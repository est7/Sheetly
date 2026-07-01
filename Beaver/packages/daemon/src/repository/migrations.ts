import type { Database } from 'bun:sqlite';

/**
 * Forward-only, `PRAGMA user_version`-anchored migrations (D8). Migration #1 is
 * the initial schema. To evolve, append a new numbered migration — never edit a
 * shipped one, never write a down migration. A DB stamped newer than we know is
 * refused, not downgraded.
 */
export const CURRENT_SCHEMA_VERSION = 2;

type Migration = { version: number; up: string };

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        base_commit TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        current_pid INTEGER,
        heartbeat_at TEXT,
        pr_url TEXT,
        block_reason TEXT,
        block_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        phase TEXT NOT NULL,
        agent_profile TEXT,
        command TEXT,
        args_json TEXT,
        prompt_path TEXT,
        stdout_path TEXT,
        stderr_path TEXT,
        transcript_path TEXT,
        diff_patch_path TEXT,
        verifier_output_path TEXT,
        exit_code INTEGER,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (run_id, attempt_number),
        UNIQUE (id, run_id),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_id TEXT,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
        FOREIGN KEY (attempt_id, run_id) REFERENCES attempts(id, run_id) ON DELETE CASCADE
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        acceptance_json TEXT NOT NULL,
        product_doc_url TEXT,
        assignee TEXT,
        business_status TEXT,
        runner_status TEXT,
        runner_owner TEXT,
        runner_run_id TEXT,
        raw_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_runs_created_at ON runs(created_at DESC);
      CREATE INDEX idx_events_run_seq ON events(run_id, seq);
      CREATE INDEX idx_attempts_run_number ON attempts(run_id, attempt_number);
      CREATE INDEX idx_artifacts_run ON artifacts(run_id);
    `
  },
  {
    // B8 resume/fix-loop: persist the agent session id so a re-run continues the
    // same conversation (claude --resume / codex thread/resume / pi --session).
    version: 2,
    up: `ALTER TABLE attempts ADD COLUMN session_id TEXT;`
  }
];

export function runMigrations(db: Database): void {
  const current = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Beaver DB schema version ${current} is newer than supported ${CURRENT_SCHEMA_VERSION}; refusing to open (forward-only, no downgrade)`
    );
  }
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length === 0) {
    return;
  }
  // The version stamp lives INSIDE the migration transaction so schema + version
  // commit atomically; a crash can never leave migrated tables at version 0.
  const apply = db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.up);
    }
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
  apply();
}
