import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../domain/errors/AppError.js';
import { logger } from '../../infra/logger/logger.js';
import { asyncHandler } from '../middlewares/asyncHandler.js';

const targetBodySchema = z.object({ target: z.record(z.unknown()) });
const mutationBodySchema = z.record(z.unknown());
const batchBodySchema = z.object({ reads: z.array(z.record(z.unknown())) });
const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_BATCH_READS = 25;

export function createDataRoutes({ manageManagerData }) {
  const router = Router();

  router.post(
    '/document',
    asyncHandler(async (request, response) => {
      const { target } = targetBodySchema.parse(request.body);
      const result = await manageManagerData.getDocument({
        actorUid: request.auth.uid,
        claims: request.auth,
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
        claims: request.auth,
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
        claims: request.auth,
        target,
      });
      response.json({ data: result });
    }),
  );

  // Leituras em lote. Cada item traz o mesmo alvo que /document, /query e /count
  // aceitam, mais o `kind` que diz qual delas e. A resposta tem o mesmo tamanho e a
  // mesma ordem da entrada.
  router.post(
    '/batch',
    asyncHandler(async (request, response) => {
      const { reads } = batchBodySchema.parse(request.body);
      if (!reads.length) {
        throw new AppError('Envie ao menos uma leitura.', {
          statusCode: 400,
          code: 'data_batch_reads_empty',
        });
      }
      if (reads.length > MAX_BATCH_READS) {
        throw new AppError(`Envie no maximo ${MAX_BATCH_READS} leituras por chamada.`, {
          statusCode: 400,
          code: 'data_batch_reads_limit',
        });
      }

      const results = await manageManagerData.readBatch({
        actorUid: request.auth.uid,
        claims: request.auth,
        reads,
      });
      response.json({
        data: results.map((result, index) => (result.ok
          ? { ok: true, data: result.data }
          : { ok: false, error: describeReadFailure(result.error, request, reads[index]) })),
      });
    }),
  );

  router.post(
    '/mutate',
    asyncHandler(async (request, response) => {
      const mutation = mutationBodySchema.parse(request.body);
      const result = await manageManagerData.mutate({
        actorUid: request.auth.uid,
        claims: request.auth,
        request: mutation,
      });
      response.json({ data: result });
    }),
  );

  // Desligado em 07/10/2026: o painel atual nao usa stream desde 03/10 e so abas com
  // codigo antigo chamavam este caminho (99,99% do tempo do backend em 05 e 06/10).
  // Responde 410 na hora, sem abrir assinatura: o onSnapshot antigo trata 4xx diferente
  // de 429 como fatal e para de reconectar.
  router.post('/stream', (_request, response) => {
    response.status(410).json({
      error: { code: 'stream_desligado', message: 'Atualize a página do gerenciador.' },
    });
  });

  return router;
}

// Stream antigo, fora da rota desde 07/10/2026. Fica aqui, com o subscribe do
// ManageManagerData, ate a rodada que apagar o codigo de stream.
// eslint-disable-next-line no-unused-vars
function abrirStream(manageManagerData) {
  return (request, response, next) => {
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
          claims: request.auth,
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
  };
}

// Falha de item nao passa pelo errorHandler, entao o motivo real e registrado aqui:
// sem isso, erro do Firestore dentro do lote ficaria invisivel no log.
function describeReadFailure(error, request, read) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }
  logger.error('data_batch_read_failed', {
    method: request.method,
    path: request.originalUrl,
    kind: read?.kind,
    originalMessage: error?.message,
    originalCode: error?.code,
    stack: error?.stack,
  });
  return { code: 'internal_error', message: 'Nao foi possivel completar esta leitura.' };
}

function writeLine(response, payload) {
  if (!response.writableEnded && !response.destroyed) {
    response.write(`${JSON.stringify(payload)}\n`);
  }
}
