import { Router } from 'express';
import { z } from 'zod';

const importProductsSchema = z.object({
  establishmentId: z.string().min(1).max(120),
  csvText: z.string().min(1),
  fileName: z.string().max(240).optional(),
});

const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().max(500).optional().default(''),
});

const pipelineParamsSchema = z.object({
  establishmentId: z.string().min(1).max(120),
  step: z.enum(['06', '07']),
  checkId: z.string().min(1).max(80),
});

export function createImplantacaoRoutes({
  importProductsFromCsvUseCase,
  manageImplantationPipelines,
  updateImplantationApprovalUseCase,
  implantationAdminMiddleware,
}) {
  const router = Router();

  router.get('/admin/pipelines', implantationAdminMiddleware, async (request, response, next) => {
    try {
      const pipelines = await manageImplantationPipelines.list({ maxItems: request.query.limit });
      response.json({ data: pipelines });
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/pipelines/:establishmentId', implantationAdminMiddleware, async (request, response, next) => {
    try {
      const pipeline = await manageImplantationPipelines.get(request.params.establishmentId);
      response.json({ data: pipeline });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/admin/pipelines/:establishmentId/checks/:step/:checkId', implantationAdminMiddleware, async (request, response, next) => {
    try {
      const params = pipelineParamsSchema.parse(request.params);
      const input = approvalSchema.parse(request.body);
      const pipeline = await updateImplantationApprovalUseCase.execute({
        ...params,
        ...input,
        adminUid: request.auth.uid,
      });
      response.json({ data: pipeline });
    } catch (error) {
      next(error);
    }
  });

  router.post('/importar-produtos', async (request, response, next) => {
    let streamStarted = false;

    const writeEvent = (event) => {
      streamStarted = true;
      response.write(`${JSON.stringify(event)}\n`);
    };

    try {
      const input = importProductsSchema.parse(request.body);
      response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders?.();

      const summary = await importProductsFromCsvUseCase.execute({
        establishmentId: input.establishmentId,
        csvText: input.csvText,
        metadata: {
          fileName: input.fileName,
          firebaseUid: request.auth?.uid,
        },
        onProgress: (progress) => writeEvent({ type: 'progress', ...progress }),
      });

      writeEvent({ type: 'done', data: summary });
      response.end();
    } catch (error) {
      if (streamStarted || response.headersSent) {
        writeEvent({
          type: 'error',
          error: {
            message: error?.message || 'Nao foi possivel importar os produtos.',
          },
        });
        response.end();
        return;
      }
      next(error);
    }
  });

  return router;
}
