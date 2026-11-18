import { z } from 'zod';

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
  messages: z.array(z.strictObject({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(32_000),
  })).max(40).refine((messages) => messages.reduce((size, message) => size + message.text.length, 0) <= 32_000, 'Conversation context exceeds budget'),
});
export type ExecutionContext = z.infer<typeof ExecutionContext>;

export const Dispatch = z.strictObject({
  type: z.literal('dispatch'), version: z.literal(ProtocolVersion),
  dispatchId: Id, context: ExecutionContext,
});
export type Dispatch = z.infer<typeof Dispatch>;
export const Approval = z.strictObject({
  approvalId: Id, command: z.string().max(16_000),
});
export const Delivery = z.strictObject({
  type: z.literal('delivery'), version: z.literal(ProtocolVersion),
  deliveryId: Id, runId: Id, sequence: z.number().int().positive(),
  event: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('progress'), text: z.string().max(32_000) }),
    z.strictObject({ kind: z.literal('outcome'), outcome: Outcome }),
    z.strictObject({ kind: z.literal('approval'), approval: Approval }),
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
  z.strictObject({ type: z.literal('receipt'), version: z.literal(ProtocolVersion), deliveryId: Id }),
]);
export const SendMessage = z.strictObject({ commandId: Id, text: z.string().trim().min(1).max(16_000) });
export const Snapshot = z.object({
  cursor: z.number().int().nonnegative(), runnerConnected: z.boolean(),
  messages: z.array(z.object({ id: Id, author: z.enum(['user', 'assistant']), text: z.string(), state: z.string() })),
  approvals: z.array(z.object({ id: Id, runId: Id, command: z.string() })),
  runners: z.array(z.object({ id: Id, status: z.string() })),
  runs: z.array(z.object({ id: Id, state: z.string() })),
});
export type Snapshot = z.infer<typeof Snapshot>;
