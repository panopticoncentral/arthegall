import { randomUUID } from "node:crypto";
import { JsonTable } from "@arthegall/shared/sqlite";

export class Agents extends JsonTable {
  constructor(db) {
    super(db, "agents");
  }
  require(id) {
    const agent = typeof id === "string" && this.get(id);
    if (!agent)
      throw Object.assign(Error("unknown agent"), { code: "INVALID_ACTION" });
    return agent;
  }
  snapshot(id) {
    const { archived, ...agent } = this.require(id);
    if (archived)
      throw Object.assign(Error("agent is archived: " + agent.name), {
        code: "INVALID_ACTION",
      });
    return agent;
  }
  save(op, args) {
    const previous = op === "agent-add" ? undefined : this.require(args.id);
    if (op === "agent-archive")
      return this.put(previous.id, { ...previous, archived: true });
    if (
      op === "agent-edit" &&
      args.name === undefined &&
      args.prompt === undefined
    )
      throw Error("supply an agent name or prompt to edit");
    const name = args.name === undefined ? previous?.name : args.name;
    const prompt = args.prompt === undefined ? previous?.prompt : args.prompt;
    if (typeof name !== "string" || !name.trim())
      throw Error("empty agent name");
    if (typeof prompt !== "string" || !prompt.trim())
      throw Error("empty agent prompt");
    const archived = op === "agent-edit" && previous.archived;
    const trimmed = name.trim();
    const key = trimmed.normalize("NFC").toLowerCase();
    if (
      !archived &&
      this.list().some(
        (a) =>
          a.id !== previous?.id &&
          !a.archived &&
          a.name.normalize("NFC").toLowerCase() === key,
      )
    )
      throw Error("another active agent has this name");
    const changed = trimmed !== previous?.name || prompt !== previous?.prompt;
    const id = previous?.id ?? randomUUID();
    return this.put(id, {
      id,
      name: trimmed,
      prompt,
      revision: (previous?.revision ?? 0) + Number(changed),
      archived,
    });
  }
}
