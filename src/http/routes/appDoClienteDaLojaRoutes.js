import { Router } from 'express';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { cuponsFiscaisDaLojaSchema } from './appDoClienteSchema.js';

// Funcoes do app do cliente pela propria loja (cola RP-58, item 2.1; decisao do Thay de 27/10): a
// loja liga e desliga so "Meus cupons fiscais" (featureFlags.cuponsFiscais, booleano). As outras
// chaves de featureFlags e a aparencia da Home continuam so pelo Admin. A loja vem da conta da
// requisicao (dono ou funcionario com a claim adminOf); gravar pede settings.edit, a mesma chave da
// entrega e das formas de pagamento. Grava so o caminho featureFlags.cuponsFiscais.
export function createAppDoClienteDaLojaRoutes({
  appDoClienteDaLoja, aparenciaDaHome = null, conjuntosDeIcones = null, requirePermission, accountForRequest,
}) {
  const router = Router();

  // Cola B57-07, item 9: a Inicio publicada da propria loja, para o celular "No app" da tela Loja (o
  // mesmo celular das Aparencias do Admin): topo, meio, fim e rodape gravados pelo Admin, a tabela das
  // variacoes (para os ajustes nao gravados) e os icones das categorias. So leitura, como as outras
  // leituras da loja; nada aqui e gravado pela loja.
  router.get('/inicio', asyncHandler(async (request, response) => {
    const { establishmentId } = await accountForRequest(request);
    const [app, variacoes, iconesDasCategorias] = await Promise.all([
      appDoClienteDaLoja.ler(establishmentId),
      aparenciaDaHome ? aparenciaDaHome.variacoes() : null,
      conjuntosDeIcones ? conjuntosDeIcones.iconesDaLoja(establishmentId) : {},
    ]);
    response.json({ data: { app: { aparenciaHome: app.aparenciaHome, ajustesDaHome: app.ajustesDaHome }, variacoes, iconesDasCategorias } });
  }));

  router.patch('/', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const entrada = cuponsFiscaisDaLojaSchema.parse(request.body);
    const { establishmentId } = await accountForRequest(request);
    const resultado = await appDoClienteDaLoja.salvar(establishmentId, entrada);
    response.json({ data: resultado.app });
  }));

  return router;
}
