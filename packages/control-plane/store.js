import { JsonTable, SQLiteState } from "@arthegall/shared/sqlite";

function initialize(db, legacy) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operator_requests (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (runner TEXT, seq INTEGER, session TEXT, body TEXT NOT NULL, PRIMARY KEY(runner,seq));
    CREATE INDEX IF NOT EXISTS session_events ON events(session,seq);
  `);
  if (legacy)
    db.exec(`
    INSERT INTO runners SELECT id,value FROM records WHERE kind='runner' ORDER BY rowid;
    INSERT INTO sessions SELECT id,value FROM records WHERE kind='session' ORDER BY rowid;
    INSERT INTO commands SELECT id,value FROM records WHERE kind='command' ORDER BY rowid;
    DROP TABLE records;
  `);
}

export class ControlStore extends SQLiteState {
  constructor(dir) {
    super(dir, "control plane", initialize);
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
