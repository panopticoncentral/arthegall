export const migrations = [{ version: 1, sql: `
CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE sessions (assignment_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL);
CREATE TABLE executions (run_id TEXT PRIMARY KEY,dispatch_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,thread_id TEXT,turn_id TEXT,model TEXT,effort TEXT,outcome TEXT,text TEXT NOT NULL DEFAULT '',sequence INTEGER NOT NULL DEFAULT 0);
CREATE TABLE deliveries (position INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,run_id TEXT NOT NULL REFERENCES executions(run_id),payload TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0);
CREATE TABLE decisions (approval_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES executions(run_id),payload TEXT NOT NULL);
` }];
