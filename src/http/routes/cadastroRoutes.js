import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { corpoDeImagem } from '../middlewares/corpoDeImagem.js';

// Cadastro de loja pelo app gerenciador. POST /loja e POST /loja/cnpj sao publicas (sem login),
// com limite de tentativas por IP, CNPJ e e-mail contado no Firestore e App Check preparado.
// As demais exigem o login da conta criada no cadastro.
const pedidoSchema = z.object({
  cnpj: z.string().max(32),
  nome: z.string().max(200),
  responsavel: z.object({
    nome: z.string().max(200),
    cpf: z.string().max(32),
    celular: z.string().max(32),
    email: z.string().max(320),
  }),
  senha: z.string().max(200),
});
const cnpjSchema = z.object({ cnpj: z.string().max(32) });
const tipoSchema = z.object({ tipo: z.enum(['logo', 'fachada']) });

export function createCadastroRoutes({ cadastroDeLoja, appCheck, exigirLogin }) {
  const router = Router();

  router.post('/loja/cnpj', appCheck, asyncHandler(async (request, response) => {
    const { cnpj } = cnpjSchema.parse(request.body);
    response.json({ data: await cadastroDeLoja.consultarCnpj(cnpj, { ip: origemDaRequisicao(request) }) });
  }));

  router.post('/loja', appCheck, asyncHandler(async (request, response) => {
    const pedido = pedidoSchema.parse(request.body);
    response.status(201).json({ data: await cadastroDeLoja.criar(pedido, { ip: origemDaRequisicao(request) }) });
  }));

  router.post('/loja/enviar-pedido', exigirLogin, asyncHandler(async (request, response) => {
    response.json({ data: await cadastroDeLoja.enviarPedido(request.auth.uid) });
  }));

  router.get('/loja/situacao', exigirLogin, asyncHandler(async (request, response) => {
    response.json({ data: await cadastroDeLoja.situacao(request.auth.uid) });
  }));

  router.post('/loja/imagens/:tipo', exigirLogin, corpoDeImagem, asyncHandler(async (request, response) => {
    const { tipo } = tipoSchema.parse(request.params);
    response.json({ data: await cadastroDeLoja.trocarImagem(request.auth.uid, tipo, request.body) });
  }));

  return router;
}

// Atras do Cloud Run, o IP do cliente vem no primeiro salto do X-Forwarded-For.
export function origemDaRequisicao(request) {
  const encaminhado = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return encaminhado || request.ip || 'desconhecida';
}
