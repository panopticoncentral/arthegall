import { z } from 'zod';

import { AdminOperation, DateRange, ReportAccess, UsageReport } from './reporting.js';

export const ProtocolVersion = 1;
export const Id = z.string().uuid();
export const Outcome = z.strictObject({
  status: z.enum(['completed', 'waiting_for_user', 'blocked']),
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
  messages: z.array(z.strictObject({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(32_000),
  })).max(40).refine((messages) => messages.reduce((size, message) => size + message.text.length, 0) <= 32_000, 'Conversation context exceeds budget'),
}).refine((context) => !(context.administrator && context.access)
  && (!(context.range || context.priorReport || context.assignmentInstructions) || Boolean(context.access)), 'Invalid execution authority');
export type ExecutionContext = z.infer<typeof ExecutionContext>;

export const Dispatch = z.strictObject({
  type: z.literal('dispatch'), version: z.literal(ProtocolVersion),
  dispatchId: Id, context: ExecutionContext,
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
export const RunnerFrame = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), version: z.literal(ProtocolVersion), runnerId: Id }),
  z.strictObject({ type: z.literal('accepted'), version: z.literal(ProtocolVersion), dispatchId: Id }),
  z.strictObject({ type: z.literal('status'), version: z.literal(ProtocolVersion), status: z.enum(['ready', 'sign_in_needed', 'unavailable']) }),
  Delivery,
  z.strictObject({ type: z.literal('decision_ack'), version: z.literal(ProtocolVersion), approvalId: Id }),
]);
export const ServerFrame = z.discriminatedUnion('type', [
  Dispatch, Decision,
  z.strictObject({ type: z.literal('receipt'), version: z.literal(ProtocolVersion), deliveryId: Id, result: OperationResult.optional() }),
]);
export const SendMessage = z.strictObject({ commandId: Id, conversationId: Id.optional(), replyTo: Id.optional(), text: z.string().trim().min(1).max(16_000) });
export const Snapshot = z.object({
  conversations: z.array(z.object({ id: Id, name: z.string(), administrator: z.number(), closed: z.number() })),
  grants: z.array(z.object({ id: Id, name: z.string(), conversationId: Id })),
  cursor: z.number().int().nonnegative(), runnerConnected: z.boolean(),
  messages: z.array(z.object({ id: Id, conversationId: Id, evidence: UsageReport.nullable(), requestedReport: z.number(), author: z.enum(['user', 'assistant']), text: z.string(), state: z.string() })),
  approvals: z.array(z.object({ id: Id, runId: Id, conversationId: Id, command: z.string() })),
  runners: z.array(z.object({ id: Id, status: z.string() })),
  runs: z.array(z.object({ id: Id, state: z.string() })),
});
export type Snapshot = z.infer<typeof Snapshot>;
