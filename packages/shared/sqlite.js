import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export class SQLiteState {
  constructor(dir, role, initialize) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "state.sqlite"));
    try {
      this.db.exec(`
        PRAGMA busy_timeout=3000;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
      `);
      this.transaction(() => {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS state_owner (role TEXT NOT NULL)",
        );
        const owner = this.db.prepare("SELECT role FROM state_owner").get();
        if (owner) {
          if (owner.role !== role)
            throw Error("state directory belongs to the " + owner.role);
          initialize(this.db, false);
          return;
        }

        // Before the stores split, each program marked its directory in records.
        const legacy = this.db
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='records'",
          )
          .get();
        if (legacy) {
          const row = this.db
            .prepare(
              "SELECT value FROM records WHERE kind='meta' AND id='role'",
            )
            .get();
          const previousRole = row && JSON.parse(row.value);
          if (previousRole && previousRole !== role)
            throw Error("state directory belongs to the " + previousRole);
        }
        initialize(this.db, Boolean(legacy));
        this.db.prepare("INSERT INTO state_owner VALUES (?)").run(role);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

// Callers supply table names from their own schema.
export class JsonTable {
  constructor(db, table) {
    this.read = db.prepare(`SELECT value FROM ${table} WHERE id=?`);
    this.write = db.prepare(`INSERT INTO ${table} (id,value) VALUES (?,?)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value`);
    this.ordered = db.prepare(`SELECT value FROM ${table} ORDER BY rowid`);
  }
  get(id) {
    const row = this.read.get(id);
    return row && JSON.parse(row.value);
  }
  put(id, value) {
    this.write.run(id, JSON.stringify(value));
    return value;
  }
  list() {
    return this.ordered.all().map((row) => JSON.parse(row.value));
  }
}

// A separate connection owns the process lock. The OS releases it on process death.
export function exclusive(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, "process.lock.sqlite"));
  try {
    db.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER)");
  } catch {
    db.close();
    throw Error("another process owns this state directory");
  }
  return db;
}
