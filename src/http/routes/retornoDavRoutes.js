import { origemDoCabecalho } from '../../domain/logs/origemDaAcao.js';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';

// Itens 5.13 e 4.21: aba "Retorno DAV" dos Logs do Gerenciador Web.
// - GET /?dias=30 (padrao 30; "todos" = sem limite): uma linha por pedido pronto para o caixa.
// - POST /:vendaId/reenviar: "Reenviar ao Linear", so em "Nao enviado", uma vez so por pedido.
// - POST /:vendaId/lancado: "Ja lancado no Linear" (5.14), na mesma condicao; o pedido nunca mais sai.
// A loja vem da conta (dono, funcionario com a permissao de ver logs, ou Admin da plataforma na loja
// escolhida por X-Loja-Alvo, que tambem entra no registro do Admin).
const listaSchema = z.object({
  dias: z.union([z.literal('todos'), z.coerce.number().int().min(1).max(3650)]).optional(),
});
const vendaSchema = z.object({ vendaId: z.string().trim().min(1).max(120).regex(/^[^/]+$/) });

export function createRetornoDavRoutes({ retornoDav, requirePermission, accountForRequest, registrarAcaoDoAdmin = null }) {
  const router = Router();

  router.get('/', requirePermission('logs.view'), asyncHandler(async (request, response) => {
    const { dias } = listaSchema.parse(request.query ?? {});
    const conta = await accountForRequest(request);
    response.json({
      data: await retornoDav.listar({ lojaId: conta.establishmentId, dias: dias === 'todos' ? null : (dias ?? 30) }),
    });
  }));

  router.post('/:vendaId/reenviar', requirePermission('logs.view'), asyncHandler(async (request, response) => {
    const { vendaId } = vendaSchema.parse(request.params);
    const conta = await accountForRequest(request);
    const ator = {
      uid: request.auth?.uid || null,
      email: request.auth?.email || null,
      quem: conta.porAdminDaPlataforma ? 'Móbile' : (conta.nome || request.auth?.email || null),
      porAdmin: conta.porAdminDaPlataforma === true,
      // Cola B57-13s, item 39: a tela e o caminho da acao no Log da equipe.
      origemDaAcao: origemDoCabecalho(String(request.headers['x-origem'] || ''), { porAdmin: conta.porAdminDaPlataforma === true }),
    };
    const linha = await retornoDav.reenviar({ lojaId: conta.establishmentId, vendaId, ator });
    if (conta.porAdminDaPlataforma && registrarAcaoDoAdmin) {
      await registrarAcaoDoAdmin({
        uid: ator.uid,
        email: ator.email,
        rota: request.originalUrl,
        lojaId: conta.establishmentId,
        detalhes: { acao: 'reenviar_ao_linear', pedido: linha.pedido },
      });
    }
    response.json({ data: linha });
  }));

  // 5.14: "Ja lancado no Linear".
  router.post('/:vendaId/lancado', requirePermission('logs.view'), asyncHandler(async (request, response) => {
    const { vendaId } = vendaSchema.parse(request.params);
    const conta = await accountForRequest(request);
    const ator = {
      uid: request.auth?.uid || null,
      email: request.auth?.email || null,
      quem: conta.porAdminDaPlataforma ? 'Móbile' : (conta.nome || request.auth?.email || null),
      porAdmin: conta.porAdminDaPlataforma === true,
      // Cola B57-13s, item 39: a tela e o caminho da acao no Log da equipe.
      origemDaAcao: origemDoCabecalho(String(request.headers['x-origem'] || ''), { porAdmin: conta.porAdminDaPlataforma === true }),
    };
    const linha = await retornoDav.marcarLancado({ lojaId: conta.establishmentId, vendaId, ator });
    if (conta.porAdminDaPlataforma && registrarAcaoDoAdmin) {
      await registrarAcaoDoAdmin({
        uid: ator.uid,
        email: ator.email,
        rota: request.originalUrl,
        lojaId: conta.establishmentId,
        detalhes: { acao: 'lancado_no_linear', pedido: linha.pedido },
      });
    }
    response.json({ data: linha });
  }));

  return router;
}
