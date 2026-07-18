import { Router } from 'express';
import { z } from 'zod';

const importProductsSchema = z.object({
  establishmentId: z.string().min(1).max(120),
  csvText: z.string().min(1),
  fileName: z.string().max(240).optional(),
});

export function createImplantacaoRoutes({ importProductsFromCsvUseCase }) {
  const router = Router();

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
