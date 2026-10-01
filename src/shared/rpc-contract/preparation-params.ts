import { z } from 'zod'

/** A paired pane's claim on a host-registered preparation role; the host fences it, never trusts it. */
export const PreparationSpawnIntakeParam = z
  .object({
    preparationId: z.string().min(1).max(128),
    role: z.enum(['preparation', 'agent'])
  })
  .strict()
