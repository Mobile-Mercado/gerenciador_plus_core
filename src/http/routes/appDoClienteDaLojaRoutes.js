import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { cuponsFiscaisDaLojaSchema } from './appDoClienteSchema.js';

// Funcoes do app do cliente pela propria loja (cola RP-58, item 2.1; decisao do Thay de 27/10): a
// loja liga e desliga so "Meus cupons fiscais" (featureFlags.cuponsFiscais, booleano). As outras
// chaves de featureFlags e a aparencia da Home continuam so pelo Admin. A loja vem da conta da
// requisicao (dono ou funcionario com a claim adminOf); gravar pede settings.edit, a mesma chave da
// entrega e das formas de pagamento. Grava so o caminho featureFlags.cuponsFiscais.
export function createAppDoClienteDaLojaRoutes({ appDoClienteDaLoja, requirePermission, accountForRequest }) {
  const router = Router();

  router.patch('/', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const entrada = cuponsFiscaisDaLojaSchema.parse(request.body);
    const { establishmentId } = await accountForRequest(request);
    const resultado = await appDoClienteDaLoja.salvar(establishmentId, entrada);
    response.json({ data: resultado.app });
  }));

  return router;
}
