import { z } from "zod";

export const recurringTaskWeekdaySchema = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

export const recurringTaskRecurrenceSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().min(1).max(12).default(1),
  daysOfWeek: z.array(recurringTaskWeekdaySchema).optional(),
  daysOfMonth: z.array(z.number().int().min(1).max(31)).optional(),
  weekOfMonth: z.union([z.number().int().min(1).max(5), z.literal("last")]).optional(),
});

export const recurringTaskSchema = z.object({
  recurringTaskId: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  recurrence: recurringTaskRecurrenceSchema,
  dueTime: z.string().regex(/^\d{2}:\d{2}$/).default("23:59"),
  timezone: z.string().min(1).default("Asia/Tokyo"),
  enabled: z.boolean().default(true),
  ownerUserId: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  sourceType: z.string().optional(),
  sourceRef: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type RecurringTaskWeekday = z.infer<typeof recurringTaskWeekdaySchema>;
export type RecurringTaskRecurrence = z.infer<typeof recurringTaskRecurrenceSchema>;
export type RecurringTask = z.infer<typeof recurringTaskSchema>;

