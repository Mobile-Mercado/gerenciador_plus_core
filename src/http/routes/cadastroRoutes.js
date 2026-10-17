import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { corpoDeImagem } from '../middlewares/corpoDeImagem.js';
import { logger } from '../../infra/logger/logger.js';

// Cadastro de loja pelo app gerenciador. POST /loja, POST /loja/cnpj, POST /evento e
// POST /rascunho sao publicas (sem login), com limite de tentativas por IP (e por CNPJ e e-mail
// no pedido) contado no Firestore e App Check preparado. As demais exigem o login da conta
// criada no cadastro.
// Formato do que chega; as regras de cada campo ficam em domain/cadastro/validacoes.js.
const erpSchema = z.object({
  escolhido: z.string().max(60),
  texto: z.string().max(200).nullish(),
});
const enderecoSchema = z.object({
  cep: z.string().max(16).nullish(),
  rua: z.string().max(200),
  numero: z.string().max(40).nullish(),
  complemento: z.string().max(200).nullish(),
  bairro: z.string().max(200).nullish(),
  cidade: z.string().max(200),
  uf: z.string().max(4),
  referencia: z.string().max(200).nullish(),
  lat: z.number(),
  lng: z.number(),
});
const pedidoSchema = z.object({
  cnpj: z.string().max(32),
  // "Nome real que esta na fachada".
  nome: z.string().max(200),
  responsavel: z.object({
    nome: z.string().max(200),
    celular: z.string().max(32),
    email: z.string().max(320),
  }),
  erp: erpSchema,
  endereco: enderecoSchema,
  instalacaoId: z.string().max(120).nullish(),
  senha: z.string().max(200),
});
const cnpjSchema = z.object({ cnpj: z.string().max(32) });
const tipoSchema = z.object({ tipo: z.enum(['logo', 'fachada']) });
// Jornada do cadastro: eventos sem dado pessoal e rascunhos de cada passo (nunca com senha).
const horaSchema = z.union([z.string().max(40), z.number()]).nullish();
const eventoSchema = z.object({
  instalacaoId: z.string().max(120),
  tipo: z.string().max(40),
  passo: z.number().int().nullish(),
  horaDoAparelho: horaSchema,
  // So na abertura: cidade aproximada do acesso, mandada pelo app. Sem ela, grava null.
  cidadeAcesso: z.object({ cidade: z.string().max(200).nullish(), uf: z.string().max(4).nullish() }).nullish(),
});
const rascunhoSchema = z.object({
  instalacaoId: z.string().max(120),
  passo: z.number().int(),
  // O formato de cada passo e conferido em domain/cadastro/validacoes.js (validarRascunho).
  dados: z.record(z.unknown()).refine((dados) => JSON.stringify(dados).length <= 8000, 'Rascunho grande demais.'),
});

export function createCadastroRoutes({
  cadastroDeLoja,
  jornadaDoCadastro = null,
  clienteDaPlataforma = null,
  appCheck,
  exigirLogin,
  registrar = (meta) => logger.info('cadastro_x_forwarded_for', meta),
}) {
  const router = Router();

  // TEMPORARIO (13/10/2026): conferir em producao a posicao do IP do cliente no X-Forwarded-For.
  // Grava so a quantidade de enderecos e as posicoes que sao do Google; nunca os IPs. Sai depois
  // de corrigida a posicao em origemDaRequisicao.
  router.use('/loja', (request, _response, next) => {
    registrar({ path: request.originalUrl.split('?')[0], ...resumoDoEncaminhamento(request.headers['x-forwarded-for']) });
    next();
  });

  router.post('/loja/cnpj', appCheck, asyncHandler(async (request, response) => {
    const { cnpj } = cnpjSchema.parse(request.body);
    response.json({ data: await cadastroDeLoja.consultarCnpj(cnpj, { ip: origemDaRequisicao(request) }) });
  }));

  router.post('/loja', appCheck, asyncHandler(async (request, response) => {
    const pedido = pedidoSchema.parse(request.body);
    response.status(201).json({ data: await cadastroDeLoja.criar(pedido, { ip: origemDaRequisicao(request) }) });
  }));

  // Sem login, com App Check e o limite por IP do cadastro (conta propria, "jornada").
  router.post('/evento', appCheck, asyncHandler(async (request, response) => {
    const evento = eventoSchema.parse(request.body);
    // Login opcional: na abertura, o app logado manda o token e o Core reconhece o lojista
    // que ja e cliente (corte dos acessos na tela do Admin). Sem token, segue igual.
    const cliente = evento.tipo === 'abertura' ? await clienteDaPlataforma?.daRequisicao(request) : null;
    response.status(201).json({ data: await jornadaDoCadastro.registrarEvento(evento, { ip: origemDaRequisicao(request), cliente }) });
  }));

  router.post('/rascunho', appCheck, asyncHandler(async (request, response) => {
    const rascunho = rascunhoSchema.parse(request.body);
    response.json({ data: await jornadaDoCadastro.gravarRascunho(rascunho, { ip: origemDaRequisicao(request) }) });
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

// TEMPORARIO (13/10/2026), junto com o registro acima. Faixas que o Google documenta para os
// proxies do Google Front End e do balanceador (35.191.0.0/16 e 130.211.0.0/22). Posicoes contam de 0.
const FAIXAS_DO_GOOGLE = [['35.191.0.0', 16], ['130.211.0.0', 22]];

function numeroDoIpv4(ip) {
  const partes = String(ip).split('.');
  if (partes.length !== 4 || partes.some((parte) => !/^\d{1,3}$/.test(parte) || Number(parte) > 255)) return null;
  return partes.reduce((soma, parte) => soma * 256 + Number(parte), 0);
}

export function resumoDoEncaminhamento(cabecalho) {
  const enderecos = String(cabecalho || '').split(',').map((item) => item.trim()).filter(Boolean);
  const posicoesDoGoogle = enderecos
    .map((endereco, posicao) => {
      const numero = numeroDoIpv4(endereco);
      if (numero === null) return null;
      const doGoogle = FAIXAS_DO_GOOGLE.some(([base, bits]) => Math.floor(numero / 2 ** (32 - bits)) === Math.floor(numeroDoIpv4(base) / 2 ** (32 - bits)));
      return doGoogle ? posicao : null;
    })
    .filter((posicao) => posicao !== null);
  return { quantidade: enderecos.length, posicoesDoGoogle };
}

// Atras do Cloud Run, o IP do cliente vem no primeiro salto do X-Forwarded-For.
export function origemDaRequisicao(request) {
  const encaminhado = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return encaminhado || request.ip || 'desconhecida';
}
