import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { entregaSchema } from './entregaSchema.js';

// Entrega da loja da sessao (cola RP-7, 18/10/2026): a mesma tela do Admin, com o mesmo contrato e
// as mesmas validacoes, inclusive as janelas proprias por dia. A loja vem da conta da requisicao.
// Gravar pede settings.edit, a chave que o BFF exige para gravar no documento da loja (e o Ajustes
// grava a entrega por ele). "Contratado" so muda pelo Admin: valor diferente do gravado e 403.
export function createEntregaDaLojaRoutes({ entregaDaLoja, requirePermission, accountForRequest }) {
  const router = Router();

  router.get('/', asyncHandler(async (request, response) => {
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: await entregaDaLoja.ler(establishmentId) });
  }));

  router.patch('/', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const entrada = entregaSchema.parse(request.body);
    const { establishmentId } = await accountForRequest(request);
    const resultado = await entregaDaLoja.salvar(establishmentId, entrada, { contratoSoDoAdmin: true });
    response.json({ data: resultado.entrega });
  }));

  return router;
}
