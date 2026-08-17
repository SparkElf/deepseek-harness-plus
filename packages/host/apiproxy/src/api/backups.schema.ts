/**
 * backups domain zod schemas (names derived from the carrier's physical
 * routes: backupExportQuerySchema for the GET download channel).
 */

import { z } from 'zod'

/** Query of the host-only GET /api/backup.export download route. */
export const backupExportQuerySchema = z.object({
  token: z.string().min(1),
})
