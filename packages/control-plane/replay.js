import { replayPartBytes } from "@arthegall/shared/protocol";

// One authenticated connection owns its incomplete event. Only the complete
// JSON event is handed to the regular ingestion transaction.
export class IncomingEvent {
  constructor(seq, bytes, partBytes = replayPartBytes) {
    // SQLite's default maximum TEXT/BLOB length bounds a journal entry.
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1_000_000_000)
      throw Error("invalid event length");
    this.seq = seq;
    this.remaining = bytes;
    this.parts = [];
    this.partBytes = partBytes;
  }
  accept(part) {
    if (part.length !== Math.min(this.remaining, this.partBytes))
      throw Error("invalid event part length");
    this.parts.push(part);
    this.remaining -= part.length;
    if (this.remaining === 0) {
      return {
        seq: this.seq,
        event: JSON.parse(Buffer.concat(this.parts).toString("utf8")),
      };
    }
  }
}
