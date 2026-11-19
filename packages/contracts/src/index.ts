import { z } from 'zod';

import { AdminOperation, DateRange, Preference, ReportAccess, UsageReport } from './reporting.js';

export const ProtocolVersion = 1;
export const Id = z.string().uuid();
export const Outcome = z.strictObject({
  status: z.enum(['completed', 'waiting_for_user', 'blocked']),
  assignmentPreference: Preference.optional(),
  message: z.string().trim().min(1).max(32_000),
});
export type Outcome = z.infer<typeof Outcome>;

export const ExecutionContext = z.strictObject({
  agentId: Id,
  assignmentId: Id,
  runId: Id,
  definitionVersion: z.number().int().positive(),
  instructions: z.string().max(16_000),
  administrator: z.literal(true).optional(),
  access: ReportAccess.optional(),
  range: DateRange.optional(),
  priorReport: UsageReport.optional(),
  assignmentInstructions: z.string().max(2000).optional(),
  occurrence: z.strictObject({ dueDate: z.iso.date(), dueAt: z.iso.datetime(), scheduleId: Id }).optional(),
  preference: z.strictObject({ revision: z.number().int().positive(), instructions: Preference }).optional(),
  messages: z.array(z.strictObject({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(32_000),
  })).max(40).refine((messages) => messages.reduce((size, message) => size + message.text.length, 0) <= 32_000, 'Conversation context exceeds budget'),
}).refine((context) => !(context.administrator && context.access)
  && (!context.occurrence || (context.access?.duration === 'recurring' && Boolean(context.range)))
  && (!context.preference || Boolean(context.access))
  && (!(context.range || context.priorReport || context.assignmentInstructions) || Boolean(context.access)), 'Invalid execution authority');
export type ExecutionContext = z.infer<typeof ExecutionContext>;

export const Dispatch = z.strictObject({
  type: z.literal('dispatch'), version: z.literal(ProtocolVersion),
  dispatchId: Id, context: ExecutionContext,
  reportMessages: z.strictObject({ conversationId: Id, userId: Id, assistantId: Id }).optional(),
});
export type Dispatch = z.infer<typeof Dispatch>;
export const Approval = z.strictObject({
  approvalId: Id, command: z.string().max(16_000),
});
export const OperationResult = z.union([
  z.strictObject({ error: z.string().max(300) }),
  z.strictObject({ name: z.string(), conversationId: Id, assignmentId: Id, reportRunId: Id.optional(), access: z.string() }),
]);
export type OperationResult = z.infer<typeof OperationResult>;
export const Delivery = z.strictObject({
  type: z.literal('delivery'), version: z.literal(ProtocolVersion),
  deliveryId: Id, runId: Id, sequence: z.number().int().positive(),
  event: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('progress'), text: z.string().max(32_000) }),
    z.strictObject({ kind: z.literal('outcome'), outcome: Outcome }),
    z.strictObject({ kind: z.literal('approval'), approval: Approval }),
    z.strictObject({ kind: z.literal('operation'), operation: AdminOperation }),
    z.strictObject({ kind: z.literal('usage'), report: UsageReport }),
    z.strictObject({ kind: z.literal('activity'), message: z.string().max(2_000) }),
  ]),
});
export type Delivery = z.infer<typeof Delivery>;
export const Decision = z.strictObject({
  type: z.literal('decision'), version: z.literal(ProtocolVersion),
  approvalId: Id, runId: Id, decision: z.enum(['accept', 'decline']),
});
export type Decision = z.infer<typeof Decision>;
export const HistoryReceipt = z.strictObject({
  kind: z.literal('history_receipt'), runId: Id, deliveryId: Id, sequence: z.number().int().positive(),
  eventKind: z.enum(['progress','activity']), digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type HistoryReceipt = z.infer<typeof HistoryReceipt>;
export const PruneHistory = z.strictObject({ type: z.literal('prune_history'), version: z.literal(1),
  runId: Id, dispatchId: Id, journalHash: z.string().regex(/^[a-f0-9]{64}$/) });
export type PruneHistory = z.infer<typeof PruneHistory>;
export const RetentionDays = z.number().int().positive();
// Recovery pulls one bounded frame at a time, including deliveries already receipted.
export const InventoryItem = z.discriminatedUnion('kind', [
  HistoryReceipt,
  z.strictObject({ kind: z.literal('execution'), pruned: z.literal(true).optional(), cleanupPending: z.literal(true).optional(), dispatch: Dispatch, state: z.enum(['queued','running','done']), outcomeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), sequence: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('delivery'), delivery: Delivery, decision: Decision.optional(), result: OperationResult.optional() }),
  z.strictObject({ kind: z.literal('end') }),
]);
export type InventoryItem = z.infer<typeof InventoryItem>;
export const RunnerFrame = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), version: z.literal(ProtocolVersion), runnerId: Id, inventoryVersion: z.literal(1).optional(), retentionVersion: z.literal(1).optional() }),
  z.strictObject({ type: z.literal('accepted'), version: z.literal(ProtocolVersion), dispatchId: Id }),
  z.strictObject({ type: z.literal('status'), version: z.literal(ProtocolVersion), status: z.enum(['ready', 'sign_in_needed', 'unavailable']) }),
  Delivery,
  z.strictObject({ type: z.literal('prune_result'), version: z.literal(1), runId: Id, dispatchId: Id, error: z.string().max(500).optional() }),
  z.strictObject({ type: z.literal('inventory'), version: z.literal(1), item: InventoryItem }),
  z.strictObject({ type: z.literal('decision_ack'), version: z.literal(ProtocolVersion), approvalId: Id }),
]);
export const ServerFrame = z.discriminatedUnion('type', [
  Dispatch, Decision, PruneHistory,
  z.strictObject({ type: z.literal('inventory_next'), version: z.literal(1) }),
  z.strictObject({ type: z.literal('receipt'), version: z.literal(ProtocolVersion), deliveryId: Id, result: OperationResult.optional() }),
]);
export const SendMessage = z.strictObject({ commandId: Id, conversationId: Id.optional(), replyTo: Id.optional(), text: z.string().trim().min(1).max(16_000) });
export const BackupSettings = z.strictObject({
  enabled: z.boolean(), destination: z.string().trim().max(4096), keep: z.number().int().positive(),
});
export type BackupSettings = z.infer<typeof BackupSettings>;
export const DailyBackupStatus = BackupSettings.extend({
  running: z.boolean(), nextDue: z.number().nullable(), lastSuccess: z.number().nullable(),
  lastPath: z.string().nullable(), error: z.string().nullable(), timeZone: z.string(),
});
export type DailyBackupStatus = z.infer<typeof DailyBackupStatus>;
export const Snapshot = z.object({
  pairings: z.array(z.object({ current: z.number(), expires: z.number() })).default([]),
  backups: DailyBackupStatus.optional(),
  retentionDays: RetentionDays,
  conversations: z.array(z.object({ id: Id, name: z.string(), administrator: z.number(), closed: z.number() })),
  schedules: z.array(z.object({ id: Id, assignmentId: Id, runnerId: Id, conversationId: Id, name: z.string(), time: z.string(), backfill: z.number(), state: z.enum(['pending','active']) })),
  grants: z.array(z.object({ id: Id, name: z.string(), conversationId: Id })),
  recovery: z.object({ runners: z.array(z.object({ id: Id, status: z.string() })),
    issues: z.array(z.object({ runId: Id, reason: z.string() })), ready: z.boolean() }).nullable(),
  cursor: z.number().int().nonnegative(), runnerConnected: z.boolean(),
  messages: z.array(z.object({ id: Id, conversationId: Id, evidence: UsageReport.nullable(), requestedReport: z.number(), author: z.enum(['user', 'assistant']), text: z.string(), state: z.string() })),
  approvals: z.array(z.object({ id: Id, runId: Id, conversationId: Id, command: z.string() })),
  runners: z.array(z.object({ id: Id, status: z.string() })),
  runs: z.array(z.object({ id: Id, state: z.string(), messageId: Id, pinned: z.number(), history: z.enum(['full','pending','pruned']), historyError: z.string().nullable() })),
});
export type Snapshot = z.infer<typeof Snapshot>;
