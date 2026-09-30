// ATENCAO, NAO COPIE ESTE PADRAO. Esta e a unica familia de rotas sem token do
// servico, e o unico caminho de escrita em PurchaseRequests que nao passa pela
// ManagerDataAccessPolicy: a pagina do entregador e aberta por link, sem login, e a
// autorizacao e o proprio deliveryCode do pedido. Ela pode gravar exatamente
// currentPurchaseStatus, statusList, deliveredBy, deliveredAt e deliveredSource, e
// nada mais; a lista fica fechada no DeliveryByCodeUseCase. Qualquer outra escrita do
// painel continua indo por /api/data/mutate e pela politica.
//
// O limite de tentativas abaixo e contado na memoria do processo: com varias
// instancias, cada uma tem o seu contador, e reinicio zera a contagem. O teto real e
// o limite multiplicado pelo numero de instancias.
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../domain/errors/AppError.js';
import { asyncHandler } from '../middlewares/asyncHandler.js';

const codigoBodySchema = z.object({ codigo: z.string().min(1).max(64) });
const LIMITE_POR_MINUTO = 10;
const LIMITE_POR_HORA = 40;
const MINUTO_MS = 60 * 1000;
const HORA_MS = 60 * MINUTO_MS;

export function createDeliveryRoutes({ deliveryByCodeUseCase, clock = () => Date.now() }) {
  const router = Router();
  const tentativas = new Map();

  const limitar = (request, _response, next) => {
    const agora = clock();
    const origem = origemDaRequisicao(request);
    const recentes = (tentativas.get(origem) || []).filter((momento) => agora - momento < HORA_MS);
    const noMinuto = recentes.filter((momento) => agora - momento < MINUTO_MS).length;
    if (noMinuto >= LIMITE_POR_MINUTO || recentes.length >= LIMITE_POR_HORA) {
      tentativas.set(origem, recentes);
      next(new AppError('Muitas tentativas. Aguarde alguns minutos.', {
        statusCode: 429,
        code: 'entrega_tentativas_excedidas',
      }));
      return;
    }
    recentes.push(agora);
    tentativas.set(origem, recentes);
    if (tentativas.size > 5000) {
      tentativas.forEach((momentos, chave) => {
        if (!momentos.some((momento) => agora - momento < HORA_MS)) tentativas.delete(chave);
      });
    }
    next();
  };

  // O codigo vai no corpo, nunca na URL: o requestLogger registra o caminho de toda
  // requisicao, e codigo em query string acabaria gravado no log.
  router.post(
    '/resumo',
    limitar,
    asyncHandler(async (request, response) => {
      const { codigo } = codigoBodySchema.parse(request.body);
      response.json({ data: await deliveryByCodeUseCase.summary(codigo) });
    }),
  );

  router.post(
    '/entregue',
    limitar,
    asyncHandler(async (request, response) => {
      const { codigo } = codigoBodySchema.parse(request.body);
      response.json({ data: await deliveryByCodeUseCase.confirm(codigo) });
    }),
  );

  return router;
}

// Atras do Cloud Run, o IP do cliente vem no primeiro salto do X-Forwarded-For.
function origemDaRequisicao(request) {
  const encaminhado = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return encaminhado || request.ip || 'desconhecida';
}
