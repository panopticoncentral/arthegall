import { randomUUID } from "node:crypto";
import { posix as path } from "node:path";
import { JsonTable } from "@arthegall/shared/sqlite";

function validRunnerPath(value) {
  return (
    typeof value === "string" && path.isAbsolute(value) && !value.includes("\0")
  );
}

function runnerPath(value) {
  if (!validRunnerPath(value))
    throw Object.assign(Error("expected an absolute path on the runner"), {
      code: "INVALID_ACTION",
    });
  return path.resolve("/", value);
}

export class Projects extends JsonTable {
  constructor(db) {
    super(db, "projects");
    this.byPath = db.prepare(`SELECT value FROM projects
      WHERE json_extract(value,'$.runner')=? AND json_extract(value,'$.cwd')=?`);
  }
  require(id) {
    const project = this.get(id);
    if (!project) throw Error("unknown project");
    return project;
  }
  define({ id, runner, name, cwd, additionalDirs = [] }) {
    cwd = runnerPath(cwd);
    if (typeof name !== "string" || !name.trim())
      throw Error("empty project name");
    if (!Array.isArray(additionalDirs))
      throw Error("expected a list of additional paths");
    const paths = new Set(additionalDirs.map(runnerPath));
    paths.delete(cwd);
    const row = this.byPath.get(runner, cwd);
    if (row) {
      const existing = JSON.parse(row.value);
      if (!id) {
        if (existing.archived)
          return this.put(existing.id, { ...existing, archived: false });
        return existing;
      }
      if (existing.id !== id)
        throw Error("another project owns this runner and primary path");
    }
    id ??= randomUUID();
    return this.put(id, {
      id,
      runner,
      name: name.trim(),
      cwd,
      additionalDirs: [...paths],
      archived: false,
    });
  }
  // Resolve the original launch syntax without restoring an archived project.
  forDirectory(runner, directory) {
    const cwd = runnerPath(directory);
    const row = this.byPath.get(runner, cwd);
    if (row) return JSON.parse(row.value);
    return this.define({ runner, cwd, name: path.basename(cwd) || cwd });
  }
}

export function migrateProjectMembership(db) {
  const projects = new Projects(db);
  const sessions = new JsonTable(db, "sessions");
  for (const session of sessions.list()) {
    if (!session.id || !session.runner || !validRunnerPath(session.cwd))
      continue;
    const project = projects.forDirectory(session.runner, session.cwd);
    sessions.put(session.id, {
      ...session,
      project: project.id,
      additionalDirs: [],
    });
  }
  const schedules = new JsonTable(db, "schedules");
  for (const schedule of schedules.list()) {
    const { op, runner, cwd, harness } = schedule.target;
    if (op !== "launch" || !validRunnerPath(cwd)) continue;
    const project = projects.forDirectory(runner, cwd);
    schedules.put(schedule.id, {
      ...schedule,
      target: { op, project: project.id, harness },
    });
  }
}
