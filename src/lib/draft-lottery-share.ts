import { z } from 'zod';

export const draftLotteryShareRequestSchema = z.object({ seasonId: z.string().uuid() }).strict();
export const draftLotteryShareIdSchema = z.string().uuid();
export const draftLotteryShareSchema = z.object({
  shareId: draftLotteryShareIdSchema,
  draftYear: z.number().int(),
  drawnAt: z.string().datetime({ offset: true }),
  sharedAt: z.string().datetime({ offset: true }),
  order: z.array(z.object({
    priority: z.number().int().min(1).max(8),
    managerLabel: z.string().trim().min(1),
    teamName: z.string().trim().min(1),
  })).length(8),
}).refine(replay => replay.order.every((entry, index) => entry.priority === index + 1), { message: 'The shared replay must contain each priority in order.' });

export type DraftLotteryShare = z.infer<typeof draftLotteryShareSchema>;
