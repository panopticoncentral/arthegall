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
` }];
