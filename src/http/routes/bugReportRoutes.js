import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';

const listQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.enum(['resolved', 'open']).optional(),
});

const reportIdParamsSchema = z.object({
  reportId: z.string().min(1),
});

const resolveSchema = z.object({
  resolved: z.boolean().default(true),
});

export function createBugReportRoutes({ manageBugReports }) {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const { from, to, status } = listQuerySchema.parse(request.query);
      const result = await manageBugReports.listReports({
        actorUid: request.auth.uid,
        from,
        to,
        resolved: status == null ? null : status === 'resolved',
      });
      response.json({ data: result });
    }),
  );

  router.post(
    '/:reportId/resolve',
    asyncHandler(async (request, response) => {
      const { reportId } = reportIdParamsSchema.parse(request.params);
      const { resolved } = resolveSchema.parse(request.body ?? {});
      await manageBugReports.setResolved({
        actorUid: request.auth.uid,
        reportId,
        resolved,
      });
      response.json({ data: { reportId, resolved } });
    }),
  );

  return router;
}
