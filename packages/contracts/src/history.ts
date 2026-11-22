// Server and runner use the same canonical wire representation.
import { createHash } from 'node:crypto';
import { Delivery, Dispatch, HistoryReceipt, OperationResult } from './index.js';

export function entryDigest(delivery: Delivery) {
  return createHash('sha256').update(JSON.stringify(Delivery.parse(delivery))).digest('hex');
}
export function compactReceipt(delivery: Delivery): HistoryReceipt {
  const eventKind = delivery.event.kind;
  if (eventKind !== 'progress' && eventKind !== 'activity') throw new Error('Delivery must be retained in full');
  return { kind: 'history_receipt', runId: delivery.runId, deliveryId: delivery.deliveryId,
    sequence: delivery.sequence, eventKind, digest: entryDigest(delivery) };
}
export function journalHash(rows: Iterable<unknown>, dispatch: Dispatch, sequence: number) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(Dispatch.parse(dispatch)));
  let next = 1;
  for (const raw of rows) {
    const row = raw as { payload: string; result: string | null; decision: string | null };
    const value = JSON.parse(row.payload);
    const entry = value.kind === 'history_receipt' ? HistoryReceipt.parse(value) : Delivery.parse(value);
    if (entry.runId !== dispatch.context.runId || entry.sequence !== next++) throw new Error('Execution journal sequence differs');
    const digest = 'event' in entry ? entryDigest(entry) : entry.digest;
    const kind = 'event' in entry ? entry.event.kind : entry.eventKind;
    const result = row.result ? OperationResult.parse(JSON.parse(row.result)) : null;
    hash.update(JSON.stringify([entry.sequence,entry.deliveryId,kind,digest,result,row.decision]));
  }
  if (next !== sequence + 1) throw new Error('Execution journal is incomplete');
  return hash.digest('hex');
}
