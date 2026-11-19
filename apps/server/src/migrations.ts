import { administratorInstructions, onDemandAdministratorInstructions } from './reporting.js';

export const migrations = [{ version: 1, sql: `
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE agents (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL);
CREATE TABLE conversations (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id));
CREATE TABLE assignments (id TEXT PRIMARY KEY, conversation_id TEXT UNIQUE NOT NULL REFERENCES conversations(id));
CREATE TABLE runners (id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unavailable');
CREATE TABLE grants (assignment_id TEXT PRIMARY KEY REFERENCES assignments(id), runner_id TEXT NOT NULL REFERENCES runners(id), tools TEXT NOT NULL);
CREATE TABLE pairing_codes (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pairing_attempts (address TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE browser_sessions (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), author TEXT NOT NULL CHECK(author IN ('user','assistant')), text TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES assignments(id), runner_id TEXT NOT NULL REFERENCES runners(id), user_message_id TEXT NOT NULL REFERENCES messages(id), assistant_message_id TEXT NOT NULL REFERENCES messages(id), state TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0);
CREATE TABLE command_receipts (session_id TEXT NOT NULL REFERENCES browser_sessions(id), command_id TEXT NOT NULL, payload TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), PRIMARY KEY(session_id,command_id));
CREATE TABLE dispatches (id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL REFERENCES runs(id), payload TEXT, accepted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE delivery_receipts (runner_id TEXT NOT NULL REFERENCES runners(id), delivery_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(runner_id,delivery_id));
CREATE TABLE approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), command TEXT NOT NULL, decision TEXT, session_id TEXT REFERENCES browser_sessions(id), acknowledged INTEGER NOT NULL DEFAULT 0);
CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX runs_assignment ON runs(assignment_id,state);
` }, { version: 2, sql: `
CREATE UNIQUE INDEX runs_user_message ON runs(user_message_id);
CREATE UNIQUE INDEX runs_assistant_message ON runs(assistant_message_id);
ALTER TABLE delivery_receipts ADD COLUMN result TEXT;
CREATE TABLE definition_history (
  agent_id TEXT NOT NULL REFERENCES agents(id), revision INTEGER NOT NULL, instructions TEXT NOT NULL,
  source_run TEXT REFERENCES runs(id), PRIMARY KEY(agent_id,revision));
INSERT INTO definition_history SELECT id,revision,instructions,NULL FROM agents;
UPDATE agents SET revision=revision+1,instructions='${onDemandAdministratorInstructions.replaceAll("'", "''")}'
  WHERE id=(SELECT value FROM metadata WHERE key='administrator');
INSERT OR IGNORE INTO definition_history SELECT id,revision,instructions,NULL FROM agents;
CREATE TABLE reporting_assignments (
  assignment_id TEXT PRIMARY KEY REFERENCES assignments(id), instructions TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0);

CREATE UNIQUE INDEX agent_name ON agents(name COLLATE NOCASE);
CREATE TABLE report_access (
  id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES assignments(id), runner_id TEXT NOT NULL REFERENCES runners(id),
  decision TEXT CHECK(decision IN ('accept','decline')), duration TEXT CHECK(duration IN ('run','assignment')),
  session_id TEXT REFERENCES browser_sessions(id), used_by TEXT REFERENCES runs(id));
CREATE UNIQUE INDEX pending_access ON report_access(assignment_id,runner_id) WHERE decision IS NULL;
CREATE TABLE report_context (
  run_id TEXT PRIMARY KEY REFERENCES runs(id), requested_range TEXT, reply_to TEXT REFERENCES runs(id), evidence TEXT);
CREATE TABLE admin_receipts (
  run_id TEXT NOT NULL REFERENCES runs(id), operation TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(run_id,operation));
` }, { version: 3, sql: `
UPDATE agents SET revision=revision+1,instructions='${administratorInstructions.replaceAll("'", "''")}'
  WHERE id=(SELECT value FROM metadata WHERE key='administrator');
INSERT OR IGNORE INTO definition_history SELECT id,revision,instructions,NULL FROM agents;

CREATE TABLE report_schedules (
  id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES reporting_assignments(assignment_id),
  runner_id TEXT NOT NULL REFERENCES runners(id), time TEXT NOT NULL, backfill INTEGER NOT NULL,
  source_run TEXT NOT NULL REFERENCES runs(id), state TEXT NOT NULL CHECK(state IN ('pending','active','retired','declined')),
  session_id TEXT REFERENCES browser_sessions(id), next_date TEXT, next_due INTEGER);
CREATE UNIQUE INDEX schedule_pending ON report_schedules(assignment_id) WHERE state='pending';
CREATE UNIQUE INDEX schedule_active ON report_schedules(assignment_id) WHERE state='active';
CREATE TABLE report_occurrences (
  assignment_id TEXT NOT NULL REFERENCES assignments(id), due_date TEXT NOT NULL, due_at INTEGER NOT NULL,
  period TEXT NOT NULL, schedule_id TEXT NOT NULL REFERENCES report_schedules(id),
  run_id TEXT UNIQUE REFERENCES runs(id), PRIMARY KEY(assignment_id,due_date));
CREATE TABLE report_preferences (
  assignment_id TEXT NOT NULL REFERENCES reporting_assignments(assignment_id), revision INTEGER NOT NULL,
  instructions TEXT NOT NULL, source_run TEXT UNIQUE NOT NULL REFERENCES report_context(run_id),
  PRIMARY KEY(assignment_id,revision));
` }];
