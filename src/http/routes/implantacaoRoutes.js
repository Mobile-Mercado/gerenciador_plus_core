import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../domain/errors/AppError.js';

const importProductsSchema = z.object({
  establishmentId: z.string().min(1).max(120),
  csvText: z.string().min(1),
  fileName: z.string().max(240).optional(),
});

const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().max(500).optional().default(''),
});

const aprovacaoFormalSchema = z.object({ nome: z.string().trim().min(2).max(80) });

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
  requirePermission,
  accountForRequest,
  registrarAcaoDoAdmin = null,
}) {
  const router = Router();
  // Admin da plataforma agindo na loja escolhida (X-Loja-Alvo) importa sem a chave da loja.
  const podeEditarProdutos = (request, response, next) => (request.lojaAlvo
    ? next()
    : requirePermission('products.edit')(request, response, next));

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

  router.post('/importar-produtos', podeEditarProdutos, async (request, response, next) => {
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
        // Loja da sessao: o caso de uso recusa importar em outra loja.
        actorEstablishmentId: (await accountForRequest(request))?.establishmentId,
        csvText: input.csvText,
        metadata: {
          fileName: input.fileName,
          firebaseUid: request.auth?.uid,
        },
        onProgress: (progress) => writeEvent({ type: 'progress', ...progress }),
      });

      if (request.lojaAlvo && registrarAcaoDoAdmin) {
        await registrarAcaoDoAdmin({
          uid: request.auth?.uid,
          email: request.auth?.email || null,
          rota: request.originalUrl,
          lojaId: request.lojaAlvo,
          detalhes: { acao: 'importar_produtos', arquivo: input.fileName || null, resumo: summary },
        });
      }
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

  // Aprovacao formal da implantacao pelo dono da loja (botao da faixa do Gerenciador Plus).
  router.post('/aprovacao-formal', async (request, response, next) => {
    try {
      const { nome } = aprovacaoFormalSchema.parse(request.body);
      const conta = await accountForRequest(request);
      if (conta.porAdminDaPlataforma || conta.permissions?.isAdmin !== true) {
        throw new AppError('Só o dono da loja faz a aprovação formal.', { statusCode: 403, code: 'implantacao_aprovacao_so_dono' });
      }
      const pipeline = await manageImplantationPipelines.aprovarFormalmente({
        establishmentId: conta.establishmentId,
        nome,
        uid: request.auth?.uid,
      });
      response.json({ data: pipeline });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
