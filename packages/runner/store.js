import { JsonTable, SQLiteState } from "@arthegall/shared/sqlite";

function initialize(db, legacy) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS command_receipts (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY, body TEXT NOT NULL);
  `);
  if (legacy)
    db.exec(`
    INSERT INTO settings SELECT id,value FROM records WHERE kind='meta' AND id<>'role';
    INSERT INTO local_sessions SELECT id,value FROM records WHERE kind='session' ORDER BY rowid;
    INSERT INTO command_receipts SELECT id,value FROM records WHERE kind='command' ORDER BY rowid;
    INSERT INTO items SELECT id,value FROM records WHERE kind='item';
    INSERT INTO journal SELECT seq,body FROM events WHERE runner='local';
    DROP TABLE records;
    DROP TABLE events;
  `);
}

export class RunnerStore extends SQLiteState {
  constructor(dir) {
    super(dir, "runner", initialize);
    this.settings = new JsonTable(this.db, "settings");
    this.sessions = new JsonTable(this.db, "local_sessions");
    this.receipts = new JsonTable(this.db, "command_receipts");
    this.items = new JsonTable(this.db, "items");
  }
  append(event) {
    this.db
      .prepare("INSERT INTO journal (body) VALUES (?)")
      .run(JSON.stringify(event));
  }
  sequence() {
    return this.db
      .prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM journal")
      .get().seq;
  }
  journalAfter(seq, limit) {
    return this.db
      .prepare("SELECT seq,body FROM journal WHERE seq>? ORDER BY seq LIMIT ?")
      .iterate(seq, limit);
  }
}
