import { z } from 'zod';

export const zone = 'America/Los_Angeles';
export const DateRange = z.strictObject({ start: z.iso.date(), end: z.iso.date() })
  .refine(({ start, end }) => start <= end, 'End must be on or after start');
export type DateRange = z.infer<typeof DateRange>;
const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
export function calendarDay(instant: Date) { return localDate.format(instant); }
export function yesterday(now = new Date()): DateRange {
  const day = new Date(calendarDay(now) + 'T00:00:00Z');
  day.setUTCDate(day.getUTCDate() - 1);
  const date = day.toISOString().slice(0, 10);
  return { start: date, end: date };
}

const count = z.number().int().nonnegative();
export const SourceUsage = z.strictObject({
  coverage: z.enum(['recorded', 'partial', 'no_records']),
  responses: count, input: count.nullable(), cachedInput: count.nullable(),
  output: count.nullable(), reasoningOutput: count.nullable(), total: count.nullable(),
  actualSpendUsd: z.number().nonnegative().nullable(), notes: z.array(z.string().max(300)).max(10),
});
export type SourceUsage = z.infer<typeof SourceUsage>;
export const UsageReport = z.strictObject({
  range: DateRange, timeZone: z.literal(zone), codex: SourceUsage, claude: SourceUsage,
  combinedTokens: count.nullable(), combinedActualSpendUsd: z.number().nonnegative().nullable(),
});
export type UsageReport = z.infer<typeof UsageReport>;

const name = z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u);
export const Definition = z.strictObject({ name, instructions: z.string().trim().min(1).max(2000) });
export const CreateAssignment = Definition.extend({ assignment: z.string().trim().min(1).max(2000).optional() });
export const ReportRequest = z.strictObject({ name, range: DateRange.optional() });
export const AdminOperation = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('create_reporting_assignment'), args: CreateAssignment }),
  z.strictObject({ tool: z.literal('revise_reporting_agent'), args: Definition }),
  z.strictObject({ tool: z.literal('run_usage_report'), args: ReportRequest }),
]);
export type AdminOperation = z.infer<typeof AdminOperation>;
export const ReportAccess = z.strictObject({
  runnerId: z.uuid(), approvalId: z.uuid(), duration: z.enum(['run', 'assignment']),
  tool: z.literal('read_usage'),
});
