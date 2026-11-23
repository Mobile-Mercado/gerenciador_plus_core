import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { ipDoCliente } from '../ipDoCliente.js';

// Item 5.10 "Acessos conectados", lado da loja (Gerenciador Web). A loja vem da conta de quem chama
// (accountForRequest), nunca do corpo.
// - POST /registrar { sessaoId?, versaoDoSistema?, retrato? }: { sessaoId, nome } (sessaoId null para
//   conta sem loja, que nao entra na lista). Navegador e sistema saem do User-Agent.
// - POST /sinal: a cada 30 s; sessao encerrada responde 401 sessao_encerrada.
// - PATCH /nome { nome }: "Nome deste computador" na primeira entrada.
const registrarSchema = z.object({
  sessaoId: z.string().max(64).nullable().optional(),
  versaoDoSistema: z.string().max(32).nullable().optional(),
  retrato: z.string().max(64).nullable().optional(),
});
const nomeSchema = z.object({ nome: z.string().max(200) });

function sessaoDoCabecalho(request) {
  return String(request.headers['x-sessao'] || '').trim();
}

export function createSessoesWebRoutes({ sessoesWeb, accountForRequest }) {
  const router = Router();

  router.post('/registrar', asyncHandler(async (request, response) => {
    const corpo = registrarSchema.parse(request.body ?? {});
    let conta;
    try {
      conta = await accountForRequest(request);
    } catch (error) {
      if (error?.code !== 'data_establishment_required') throw error;
      response.json({ data: { sessaoId: null, nome: null } });
      return;
    }
    response.json({
      data: await sessoesWeb.registrar({
        lojaId: conta.establishmentId,
        uid: request.auth.uid,
        sessaoId: corpo.sessaoId ?? null,
        userAgent: request.headers['user-agent'],
        versaoDoSistema: corpo.versaoDoSistema ?? null,
        retrato: corpo.retrato ?? null,
        ip: ipDoCliente(request),
      }),
    });
  }));

  router.post('/sinal', asyncHandler(async (request, response) => {
    const conta = await accountForRequest(request);
    response.json({
      data: await sessoesWeb.sinal({ lojaId: conta.establishmentId, sessaoId: sessaoDoCabecalho(request), ip: ipDoCliente(request) }),
    });
  }));

  router.patch('/nome', asyncHandler(async (request, response) => {
    const { nome } = nomeSchema.parse(request.body ?? {});
    const conta = await accountForRequest(request);
    response.json({
      data: await sessoesWeb.nomearPelaLoja({ lojaId: conta.establishmentId, sessaoId: sessaoDoCabecalho(request), nome }),
    });
  }));

  return router;
}
