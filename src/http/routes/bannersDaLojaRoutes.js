import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { corpoDeImagem } from '../middlewares/corpoDeImagem.js';
import { alterarBannerSchema } from './aparenciaSchema.js';

// Banners da loja pelo Gerenciador (rodada de 13/10/2026): o corpo e a imagem ja recortada pelo
// painel (1080 x 500) e o periodo vai na consulta (?inicio=...&fim=..., ISO). O Core grava como o
// app gerenciador grava, com image.size em decimal.
const periodoSchema = z.object({ inicio: z.string().min(1).max(40), fim: z.string().min(1).max(40) });
const idSchema = z.object({ bannerId: z.string().min(1).max(120).regex(/^[^/]+$/) });
// Pausar ou Retomar um banner da loja da sessao (15/10/2026), com a mesma permissao de editar banner.
const situacaoSchema = z.object({ acao: z.enum(['pausar', 'retomar']) });

// Cola B57-07 (tela Loja, banners por tipo): Principal, Vertical e Popup, com os limites, as medidas e
// o peso do Admin (BannersNoAdmin). "Abaixo do vertical" nao aparece nesta tela. A loja vem da conta
// da requisicao; gravar pede settings.edit, a mesma chave dos banners de hoje.
export const TIPOS_DA_TELA_LOJA = Object.freeze(['principal', 'vertical', 'popup']);
const novoPorTipoSchema = z.object({ tipo: z.enum(TIPOS_DA_TELA_LOJA), inicio: z.string().min(1).max(40), fim: z.string().min(1).max(40) });
const levaParaSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('nada') }).strict(),
  // Cola B57-10, item B2: "Ofertas" (grava destino: 'ofertas').
  z.object({ tipo: z.literal('ofertas') }).strict(),
  z.object({ tipo: z.literal('produtos'), ids: z.array(z.string().min(1).max(120).regex(/^[^/]+$/)).min(1).max(100) }).strict(),
  z.object({ tipo: z.literal('categoria'), id: z.string().min(1).max(120).regex(/^[^/]+$/) }).strict(),
]);
const alterarNaLojaSchema = alterarBannerSchema.extend({ levaPara: levaParaSchema.optional() }).strict();

export function createBannersDaLojaRoutes({ bannersDaLoja, bannersPorTipo = null, requirePermission, accountForRequest }) {
  const router = Router();

  if (bannersPorTipo) {
    // Os banners da loja por tipo, com ligados sobre o limite (sem os encerrados, como o Admin).
    router.get('/por-tipo', asyncHandler(async (request, response) => {
      const { establishmentId } = await accountForRequest(request);
      const lista = await bannersPorTipo.listar(establishmentId);
      const tipos = Object.fromEntries(TIPOS_DA_TELA_LOJA.map((tipo) => [tipo, lista.tipos[tipo]]));
      response.json({ data: { ...lista, tipos } });
    }));

    // Cola B57-10, item B1: os destinos com conteudo para o "Leva para" (as categorias que o app mostra
    // e que tem produto a venda).
    router.get('/por-tipo/destinos', asyncHandler(async (request, response) => {
      const { establishmentId } = await accountForRequest(request);
      response.json({ data: { categorias: await bannersPorTipo.categoriasComConteudo(establishmentId) } });
    }));

    // Cola B57-07b, item 13 (parte C): os encerrados de Principal, Vertical e Popup, e o "Usar de novo".
    router.get('/por-tipo/encerrados', asyncHandler(async (request, response) => {
      const { establishmentId } = await accountForRequest(request);
      const lista = await bannersPorTipo.encerrados(establishmentId);
      response.json({ data: lista.filter((banner) => TIPOS_DA_TELA_LOJA.includes(banner.tipo)) });
    }));

    router.post('/por-tipo/:bannerId/usar-de-novo', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
      const { bannerId } = idSchema.parse(request.params);
      const { establishmentId } = await accountForRequest(request);
      response.json({ data: (await bannersPorTipo.usarDeNovo(establishmentId, bannerId)).banner });
    }));

    // "Criar novo": o tipo no limite cria o banner desligado.
    router.post('/por-tipo', requirePermission('settings.edit'), corpoDeImagem, asyncHandler(async (request, response) => {
      const { tipo, inicio, fim } = novoPorTipoSchema.parse(request.query);
      const { establishmentId } = await accountForRequest(request);
      const banner = await bannersPorTipo.criar(establishmentId, tipo, request.body, request.headers['content-type'], { inicio, fim }, { noLimite: 'desligar' });
      response.status(201).json({ data: banner });
    }));

    // Lapis: troca a imagem, na medida do tipo.
    router.put('/por-tipo/:bannerId/imagem', requirePermission('settings.edit'), corpoDeImagem, asyncHandler(async (request, response) => {
      const { bannerId } = idSchema.parse(request.params);
      const { establishmentId } = await accountForRequest(request);
      const resultado = await bannersPorTipo.trocarImagem(establishmentId, bannerId, request.body, request.headers['content-type']);
      response.json({ data: resultado.banner });
    }));

    // Faixa de edicao: "Quando", "Leva para", "Contador" e "Ligado" (ligar alem do limite: 409).
    router.patch('/por-tipo/:bannerId', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
      const { bannerId } = idSchema.parse(request.params);
      const { levaPara, ...campos } = alterarNaLojaSchema.parse(request.body || {});
      const { establishmentId } = await accountForRequest(request);
      let banner = null;
      if (Object.keys(campos).length) banner = (await bannersPorTipo.alterar(establishmentId, bannerId, campos)).banner;
      if (levaPara) banner = (await bannersPorTipo.mudarDestino(establishmentId, bannerId, levaPara)).banner;
      if (!banner) banner = await bannersPorTipo.ler(establishmentId, bannerId);
      response.json({ data: banner });
    }));

    // Lixeira (a tela confirma antes).
    router.delete('/por-tipo/:bannerId', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
      const { bannerId } = idSchema.parse(request.params);
      const { establishmentId } = await accountForRequest(request);
      response.json({ data: await bannersPorTipo.apagar(establishmentId, bannerId) });
    }));
  }

  router.post('/', requirePermission('settings.edit'), corpoDeImagem, asyncHandler(async (request, response) => {
    const periodo = periodoSchema.parse(request.query);
    const { establishmentId } = await accountForRequest(request);
    response.status(201).json({ data: await bannersDaLoja.criar(establishmentId, request.body, periodo) });
  }));

  router.put('/:bannerId', requirePermission('settings.edit'), corpoDeImagem, asyncHandler(async (request, response) => {
    const periodo = periodoSchema.parse(request.query);
    const { bannerId } = idSchema.parse(request.params);
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: await bannersDaLoja.editar(establishmentId, bannerId, request.body, periodo) });
  }));

  router.patch('/:bannerId/situacao', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const { bannerId } = idSchema.parse(request.params);
    const { acao } = situacaoSchema.parse(request.body || {});
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: await bannersDaLoja.mudarSituacao(establishmentId, bannerId, acao) });
  }));

  return router;
}
