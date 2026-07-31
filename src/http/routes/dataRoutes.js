import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';

const targetBodySchema = z.object({ target: z.record(z.unknown()) });
const mutationBodySchema = z.record(z.unknown());
const HEARTBEAT_INTERVAL_MS = 20_000;

export function createDataRoutes({ manageManagerData }) {
  const router = Router();

  router.post(
    '/document',
    asyncHandler(async (request, response) => {
      const { target } = targetBodySchema.parse(request.body);
      const result = await manageManagerData.getDocument({
        actorUid: request.auth.uid,
        target,
      });
      response.json({ data: result });
    }),
  );

  router.post(
    '/query',
    asyncHandler(async (request, response) => {
      const { target } = targetBodySchema.parse(request.body);
      const result = await manageManagerData.getDocuments({
        actorUid: request.auth.uid,
        target,
      });
      response.json({ data: result });
    }),
  );

  router.post(
    '/count',
    asyncHandler(async (request, response) => {
      const { target } = targetBodySchema.parse(request.body);
      const result = await manageManagerData.countDocuments({
        actorUid: request.auth.uid,
        target,
      });
      response.json({ data: result });
    }),
  );

  router.post(
    '/mutate',
    asyncHandler(async (request, response) => {
      const mutation = mutationBodySchema.parse(request.body);
      const result = await manageManagerData.mutate({
        actorUid: request.auth.uid,
        request: mutation,
      });
      response.json({ data: result });
    }),
  );

  router.post('/stream', (request, response, next) => {
    let unsubscribe = () => {};
    let heartbeat = null;
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    };
    response.on('close', close);

    Promise.resolve()
      .then(async () => {
        const { target } = targetBodySchema.parse(request.body);
        response.status(200);
        response.set({
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders();
        writeLine(response, { type: 'ready' });

        unsubscribe = await manageManagerData.subscribe({
          actorUid: request.auth.uid,
          target,
          onSnapshot: (snapshot) => writeLine(response, { type: 'snapshot', snapshot }),
          onError: (error) => {
            writeLine(response, {
              type: 'error',
              error: {
                code: error?.code || 'data_stream_failed',
                message: 'A atualizacao em tempo real foi interrompida.',
              },
            });
            close();
            response.end();
          },
        });

        heartbeat = setInterval(() => {
          writeLine(response, { type: 'heartbeat', at: Date.now() });
        }, HEARTBEAT_INTERVAL_MS);
        heartbeat.unref?.();
      })
      .catch((error) => {
        if (response.headersSent) {
          writeLine(response, {
            type: 'error',
            error: {
              code: error?.code || 'data_stream_failed',
              message: error?.message || 'Nao foi possivel abrir a atualizacao em tempo real.',
            },
          });
          close();
          response.end();
          return;
        }
        next(error);
      });
  });

  return router;
}

function writeLine(response, payload) {
  if (!response.writableEnded && !response.destroyed) {
    response.write(`${JSON.stringify(payload)}\n`);
  }
}
