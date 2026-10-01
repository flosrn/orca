import { z } from 'zod'
import { PREPARATION_OUTPUT_READ_PAGE_MAX_BYTES } from '../preparation-output-read'
import { WorktreeSelector } from './worktree-params'

export const PreparationOutputListParams = WorktreeSelector.extend({})

export const PreparationOutputReadParams = z.object({
  // Why permissive: the archive store owns ID validation so traversal gets its explicit code.
  archiveId: z.string().min(1, 'Missing archive id').max(256),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(PREPARATION_OUTPUT_READ_PAGE_MAX_BYTES).optional()
})
