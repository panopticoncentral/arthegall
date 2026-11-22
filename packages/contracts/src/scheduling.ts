import { z } from 'zod';

export const ScheduleTiming = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('at'), at: z.iso.datetime({ offset: true }) }),
  z.strictObject({ kind: z.literal('after'), seconds: z.int().positive().max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) }),
  z.strictObject({ kind: z.literal('cron'), expression: z.string().trim().min(1).max(200), timeZone: z.string().trim().min(1).max(100) }),
]);
export type ScheduleTiming = z.infer<typeof ScheduleTiming>;

export const ScheduleItem = z.strictObject({
  instruction: z.string().trim().min(1).max(2000), when: ScheduleTiming,
  missed: z.enum(['latest', 'all']).default('latest'),
});
export const ChangeItem = ScheduleItem.extend({ id: z.uuid() });
export const ItemId = z.strictObject({ id: z.uuid() });
export const ListItems = z.strictObject({ afterId: z.uuid().optional() });
export const ScheduleOperation = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('schedule_item'), args: ScheduleItem }),
  z.strictObject({ tool: z.literal('change_scheduled_item'), args: ChangeItem }),
  z.strictObject({ tool: z.literal('cancel_scheduled_item'), args: ItemId }),
  z.strictObject({ tool: z.literal('list_scheduled_items'), args: ListItems }),
]);
export type ScheduleOperation = z.infer<typeof ScheduleOperation>;
export const ScheduledItemResult = z.strictObject({ id: z.uuid(), nextDue: z.iso.datetime().nullable() });
export const ScheduleListResult = z.strictObject({
  items: z.array(ScheduledItemResult.extend({ instruction: z.string(), when: ScheduleTiming, missed: z.enum(['latest', 'all']) })),
  nextAfterId: z.uuid().nullable(),
});
