import { JsonTable, SQLiteState } from "@arthegall/shared/sqlite";
import { Projects, migrateProjectMembership } from "./projects.js";

function initialize(db, legacy) {
  const existingProjects = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='projects'",
    )
    .get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS project_workspace ON projects(json_extract(value,'$.runner'),json_extract(value,'$.cwd'));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operator_requests (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS uncertain_commands ON commands(id) WHERE json_extract(value,'$.status')='uncertain';
    CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules(json_extract(value,'$.nextDue'));
    CREATE TABLE IF NOT EXISTS occurrences (
      schedule TEXT NOT NULL, due TEXT NOT NULL, zone TEXT NOT NULL, status TEXT NOT NULL,
      command TEXT UNIQUE, session TEXT, turn TEXT, detail TEXT, missed TEXT,
      PRIMARY KEY(schedule,due)
    );
    CREATE INDEX IF NOT EXISTS occurrence_status ON occurrences(status,schedule,due);
    CREATE INDEX IF NOT EXISTS occurrence_session ON occurrences(session,turn);
    CREATE TABLE IF NOT EXISTS events (runner TEXT, seq INTEGER, session TEXT, body TEXT NOT NULL, PRIMARY KEY(runner,seq));
    CREATE INDEX IF NOT EXISTS session_events ON events(session,seq);
  `);
  // Early scheduler checkouts stored the missed-work policy only on the schedule.
  if (
    !db
      .prepare(
        "SELECT 1 FROM pragma_table_info('occurrences') WHERE name='missed'",
      )
      .get()
  ) {
    db.exec(`ALTER TABLE occurrences ADD COLUMN missed TEXT;
      UPDATE occurrences SET missed=(SELECT json_extract(value,'$.rule.missed')
        FROM schedules WHERE id=occurrences.schedule)`);
  }
  if (legacy)
    db.exec(`
    INSERT INTO runners SELECT id,value FROM records WHERE kind='runner' ORDER BY rowid;
    INSERT INTO sessions SELECT id,value FROM records WHERE kind='session' ORDER BY rowid;
    INSERT INTO commands SELECT id,value FROM records WHERE kind='command' ORDER BY rowid;
    DROP TABLE records;
  `);
  if (!existingProjects) migrateProjectMembership(db);
}

export class ControlStore extends SQLiteState {
  constructor(dir) {
    super(dir, "control plane", initialize);
    this.projects = new Projects(this.db);
    this.schedules = new JsonTable(this.db, "schedules");
    this.requests = new JsonTable(this.db, "operator_requests");
    this.runners = new JsonTable(this.db, "runners");
    this.sessions = new JsonTable(this.db, "sessions");
    this.commands = new JsonTable(this.db, "commands");
  }
  sequence(runner) {
    return this.db
      .prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE runner=?")
      .get(runner).seq;
  }
  append(runner, seq, event) {
    this.db
      .prepare("INSERT INTO events VALUES (?,?,?,?)")
      .run(runner, seq, event.session ?? "", JSON.stringify(event));
  }
  history(session, after = 0) {
    return this.db
      .prepare(
        "SELECT seq,body FROM events WHERE session=? AND seq>? ORDER BY seq",
      )
      .all(session, after)
      .map((row) => ({ seq: row.seq, ...JSON.parse(row.body) }));
  }
}
