import { Router } from 'express';
import { z } from 'zod';
import { ARQUIVOS_DO_FUNDO } from '../../domain/loja/aparencias.js';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { arquivoDaAparenciaSchema, fundoDeOfertasSchema } from './aparenciaSchema.js';

// Fundo de Ofertas pela propria loja (cola B56-04, item 3.4). A loja vem da conta da requisicao;
// gravar pede settings.edit, como a entrega e as formas de pagamento. So grava ofertas.fundo e
// so quando o Admin ligou ofertas.lojistaPodeTrocarFundo; desligado, 403. O resto das
// Aparencias (conjunto de icones, cabecalho de Ofertas, Abertura e Primeira tela) e so do Admin.
const tipoDoArquivoSchema = z.enum(Object.keys(ARQUIVOS_DO_FUNDO));

export function createAparenciaDaLojaRoutes({ aparenciaDaLoja, requirePermission, accountForRequest }) {
  const router = Router();

  router.get('/', asyncHandler(async (request, response) => {
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: await aparenciaDaLoja.ler(establishmentId) });
  }));

  router.patch('/ofertas/fundo', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const fundo = fundoDeOfertasSchema.parse(request.body);
    const { establishmentId } = await accountForRequest(request);
    const resultado = await aparenciaDaLoja.salvar(establishmentId, { ofertas: { fundo } }, { soFundo: true });
    response.json({ data: resultado.aparencia });
  }));

  router.post('/ofertas/fundo/arquivos/:tipo', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const tipo = tipoDoArquivoSchema.parse(request.params.tipo);
    const entrada = arquivoDaAparenciaSchema.parse(request.body);
    const { establishmentId } = await accountForRequest(request);
    const resultado = await aparenciaDaLoja.enviarArquivo(establishmentId, ARQUIVOS_DO_FUNDO[tipo], entrada, { soFundo: true });
    response.json({ data: resultado.aparencia });
  }));

  return router;
}
