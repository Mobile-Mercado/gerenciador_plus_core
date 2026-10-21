import { Router } from 'express';
import { z } from 'zod';
import { formatarNome } from '../../domain/catalogo/formatarNome.js';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { corpoDeImagem } from '../middlewares/corpoDeImagem.js';
import { appDoClienteSchema, formasDePagamentoSchema } from './appDoClienteSchema.js';
import { entregaSchema } from './entregaSchema.js';

// Rotas do Admin da plataforma. A barreira (requirePlatformAdmin) e o registro de quem agiu
// (adminAudit) entram em app.js, antes deste roteador. Nao existe rota de excluir: item
// retirado da lista padrao e arquivado.

const tipoSchema = z.enum(['categorias', 'subcategorias']);
const criarSchema = z.object({
  nome: z.string().min(1).max(80),
  categoriaId: z.string().min(1).max(120).optional(),
});
const editarSchema = z.object({
  nome: z.string().min(1).max(80).optional(),
  order: z.number().int().min(0).max(100000).optional(),
  travada: z.boolean().optional(),
});
const estadoSchema = z.object({ estado: z.enum(['ligada', 'desligada', 'arquivada', 'restaurada']) });
const iconeSchema = z.object({
  conteudoBase64: z.string().min(1).max(600000),
  tipoArquivo: z.string().min(1).max(40),
});
const liberacaoSchema = z.object({
  lojaId: z.string().min(1).max(120),
  categoriaId: z.string().min(1).max(120),
});
const decisaoSchema = z.object({
  decisao: z.enum(['aprovada', 'recusada']),
  motivo: z.string().max(500).optional(),
});
const formatarSchema = z.object({ nome: z.string().max(200) });
const listaPedidosSchema = z.object({
  lista: z.enum(['abertos', 'parados', 'aprovados', 'recusados', 'incompletos', 'descartados']).optional(),
});
// Cadastro incompleto: "Em conversa", "Descartar" ou voltar para em andamento (so marca).
const situacaoIncompletoSchema = z.object({ situacao: z.enum(['em_conversa', 'descartado', 'em_andamento']) });
const instalacaoParamsSchema = z.object({ instalacaoId: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/) });
const recusaSchema = z.object({ motivo: z.string().max(500) });
const jornadaDeEntradaSchema = z.object({
  periodo: z.coerce.number().int().refine((dias) => [7, 30, 90].includes(dias), 'Período inválido.').default(30),
  uf: z.string().length(2).optional(),
});
const emConversaSchema = z.object({ emConversa: z.boolean() });
const edicaoLojaSchema = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().max(40).optional(),
  cnpj: z.string().max(40).optional(),
  address: z.object({
    street: z.string().max(200).nullable().optional(),
    number: z.string().max(40).nullable().optional(),
    complement: z.string().max(200).nullable().optional(),
    neighborhood: z.string().max(120).nullable().optional(),
    city: z.string().max(120).nullable().optional(),
    uf: z.string().max(2).nullable().optional(),
    zipCode: z.string().max(20).nullable().optional(),
  }).optional(),
});
const ativarSchema = z.object({ ativa: z.boolean() });
const excluirLojaSchema = z.object({ confirmacaoNome: z.string().max(200) });
const aparenciaSchema = z.object({
  primaryColor: z.string().max(7).nullable().optional(),
  secondaryColor: z.string().max(7).nullable().optional(),
  offerColor: z.string().max(7).nullable().optional(),
  slogan: z.string().max(200).nullable().optional(),
});
const imagemAdminSchema = z.object({ tipo: z.enum(['logo', 'fachada', 'splash', 'loading']) });
const agendamentoSchema = z.object({ contracted: z.boolean() });
const franquiaSchema = z.object({
  nomeFranquia: z.string().max(200).optional(),
  nomeFranqueado: z.string().max(200).optional(),
  cidadeValue: z.string().max(200).optional(),
}).strict();
const novoAdminSchema = z.object({ nome: z.string().max(200), email: z.string().max(320), senha: z.string().max(200).optional() });
const experienciaSchema = z.object({
  dias: z.coerce.number().int().optional(),
  lojaId: z.string().max(120).optional(),
});
const appNasLojasSchema = z.object({ feito: z.boolean() });

const tipoDe = (plural) => (tipoSchema.parse(plural) === 'categorias' ? 'categoria' : 'subcategoria');
const atorDe = (request) => ({ uid: request.auth?.uid || null, email: request.auth?.email || null });

const sugestoesClientesSchema = z.object({
  lojaId: z.string().min(1).max(120).optional(),
  busca: z.string().max(200).optional(),
  cursor: z.string().min(1).max(400).optional(),
});

export function createAdminRoutes({
  manageCatalogoPadrao, sugestoesDosClientes, pedidosDeLoja, lojaNoAdmin, franquias, administradores, dadosDoAdmin,
  manageImplantationPipelines, jornadaDeEntrada = null, entregaDaLoja = null, appDoClienteDaLoja = null,
  formasDePagamento = null,
}) {
  const router = Router();

  router.get('/sessao', (request, response) => {
    response.json({ data: { uid: request.auth.uid, email: request.auth.email || null, isPlatformAdmin: true } });
  });

  router.post('/formatar-nome', (request, response) => {
    const { nome } = formatarSchema.parse(request.body);
    response.json({ data: { nome: formatarNome(nome) } });
  });

  router.get('/lojas', asyncHandler(async (_request, response) => {
    response.json({ data: await manageCatalogoPadrao.lojas() });
  }));

  // ===== Estabelecimentos: so leitura nesta rodada, mais a liberacao =====
  router.get('/estabelecimentos', asyncHandler(async (_request, response) => {
    response.json({ data: await manageCatalogoPadrao.estabelecimentos() });
  }));

  router.get('/estabelecimentos/:lojaId', asyncHandler(async (request, response) => {
    response.json({ data: await manageCatalogoPadrao.estabelecimento(request.params.lojaId) });
  }));

  // ===== Sugestoes dos clientes (app), de todas as lojas: so leitura =====
  router.get('/sugestoes-clientes', asyncHandler(async (request, response) => {
    const input = sugestoesClientesSchema.parse(request.query);
    response.json({ data: await sugestoesDosClientes.listar(input) });
  }));

  // ===== Sugestoes das lojas =====
  router.get('/sugestoes', asyncHandler(async (request, response) => {
    const estado = typeof request.query.estado === 'string' ? request.query.estado : 'pendente';
    response.json({ data: await manageCatalogoPadrao.sugestoes({ estado: estado === 'todas' ? '' : estado }) });
  }));

  router.patch('/sugestoes/:lojaId/:id', asyncHandler(async (request, response) => {
    response.locals.lojasAlvo = [request.params.lojaId];
    const input = decisaoSchema.parse(request.body);
    const result = await manageCatalogoPadrao.decidirSugestao(request.params.lojaId, request.params.id, input, atorDe(request));
    response.json({ data: result });
  }));

  // ===== Liberacao de categoria travada por loja =====
  router.post('/liberacoes', asyncHandler(async (request, response) => {
    const input = liberacaoSchema.parse(request.body);
    response.json({ data: await manageCatalogoPadrao.liberar(input, atorDe(request)) });
  }));

  router.delete('/liberacoes/:lojaId/:categoriaId', asyncHandler(async (request, response) => {
    response.locals.lojasAlvo = [request.params.lojaId];
    const input = liberacaoSchema.parse(request.params);
    response.json({ data: await manageCatalogoPadrao.revogar(input) });
  }));

  // ===== Jornada de entrada (App Gerenciador): so leitura do funil do cadastro =====
  router.get('/jornada-de-entrada', asyncHandler(async (request, response) => {
    const { periodo, uf } = jornadaDeEntradaSchema.parse(request.query);
    response.json({ data: await jornadaDeEntrada.ler({ periodo, uf: uf || null }) });
  }));

  // ===== Pedidos de loja (cadastro pelo app gerenciador) =====
  router.get('/pedidos-de-loja', asyncHandler(async (request, response) => {
    const { lista } = listaPedidosSchema.parse(request.query);
    response.json({ data: await pedidosDeLoja.listar(lista || 'abertos') });
  }));

  router.post('/pedidos-de-loja/incompletos/:instalacaoId/situacao', asyncHandler(async (request, response) => {
    const { instalacaoId } = instalacaoParamsSchema.parse(request.params);
    const { situacao } = situacaoIncompletoSchema.parse(request.body);
    response.locals.auditoria = { acao: 'marcar_cadastro_incompleto', instalacaoId, situacao };
    response.json({ data: await pedidosDeLoja.marcarIncompleto(instalacaoId, situacao, atorDe(request)) });
  }));

  // O parametro e o id do pedido (pedidosDeLoja): a loja so nasce no "Aprovar", e o registro do
  // Admin vai para a loja criada.
  router.post('/pedidos-de-loja/:pedidoId/aprovar', asyncHandler(async (request, response) => {
    const resultado = await pedidosDeLoja.aprovar(request.params.pedidoId, atorDe(request));
    response.locals.lojasAlvo = [resultado.lojaId].filter(Boolean);
    response.locals.auditoria = {
      acao: 'aprovar_pedido_de_loja',
      pedidoId: request.params.pedidoId,
      uidDono: resultado.uidDono,
      claimsAntigas: resultado.claimsAntigas,
      claimsNovas: resultado.claimsNovas,
    };
    response.json({ data: resultado });
  }));

  router.post('/pedidos-de-loja/:pedidoId/recusar', asyncHandler(async (request, response) => {
    const { motivo } = recusaSchema.parse(request.body);
    response.locals.auditoria = { acao: 'recusar_pedido_de_loja', pedidoId: request.params.pedidoId, motivo };
    response.json({ data: await pedidosDeLoja.recusar(request.params.pedidoId, motivo, atorDe(request)) });
  }));

  router.post('/pedidos-de-loja/:pedidoId/em-conversa', asyncHandler(async (request, response) => {
    const { emConversa } = emConversaSchema.parse(request.body);
    response.locals.auditoria = { acao: emConversa ? 'marcar_em_conversa' : 'desmarcar_em_conversa', pedidoId: request.params.pedidoId };
    response.json({ data: await pedidosDeLoja.marcarEmConversa(request.params.pedidoId, emConversa) });
  }));

  // ===== Loja aberta no Admin =====
  router.get('/estabelecimentos/:lojaId/resumo', asyncHandler(async (request, response) => {
    response.json({ data: await lojaNoAdmin.resumo(request.params.lojaId) });
  }));

  router.get('/estabelecimentos/:lojaId/contas', asyncHandler(async (request, response) => {
    response.json({ data: await lojaNoAdmin.contas(request.params.lojaId) });
  }));

  router.post('/estabelecimentos/:lojaId/contas/:uid/acesso/previa', asyncHandler(async (request, response) => {
    response.json({ data: await lojaNoAdmin.previaDoAcesso(request.params.lojaId, request.params.uid) });
  }));

  // Corrigir acesso: a claim antiga fica guardada no adminAuditLogs.
  router.post('/estabelecimentos/:lojaId/contas/:uid/acesso', asyncHandler(async (request, response) => {
    const resultado = await lojaNoAdmin.corrigirAcesso(request.params.lojaId, request.params.uid);
    response.locals.auditoria = {
      acao: 'corrigir_acesso',
      uidConta: request.params.uid,
      claimsAntigas: resultado.claimsAntigas,
      claimsNovas: resultado.claimsNovas,
    };
    response.json({ data: resultado });
  }));

  router.post('/estabelecimentos/:lojaId/edicao/previa', asyncHandler(async (request, response) => {
    const entrada = edicaoLojaSchema.parse(request.body);
    response.json({ data: await lojaNoAdmin.previaDaEdicao(request.params.lojaId, entrada) });
  }));

  router.patch('/estabelecimentos/:lojaId', asyncHandler(async (request, response) => {
    const entrada = edicaoLojaSchema.parse(request.body);
    const resultado = await lojaNoAdmin.editar(request.params.lojaId, entrada);
    response.locals.auditoria = { acao: 'editar_loja', diferencas: resultado.diferencas };
    response.json({ data: resultado });
  }));

  // Ligar no app Mobile Supermercados (isActive): sempre manual, por aqui.
  router.post('/estabelecimentos/:lojaId/ativar', asyncHandler(async (request, response) => {
    const { ativa } = ativarSchema.parse(request.body);
    const resultado = await lojaNoAdmin.ativarNoApp(request.params.lojaId, ativa);
    response.locals.auditoria = { acao: ativa ? 'ligar_no_app' : 'desligar_no_app', antes: resultado.antes };
    response.json({ data: resultado });
  }));

  router.get('/estabelecimentos/:lojaId/exclusao', asyncHandler(async (request, response) => {
    response.json({ data: await lojaNoAdmin.previaDaExclusao(request.params.lojaId) });
  }));

  // Excluir so loja sem pedidos e sem produtos, com o nome digitado; o documento como estava vai
  // para o adminAuditLogs.
  router.delete('/estabelecimentos/:lojaId', asyncHandler(async (request, response) => {
    const { confirmacaoNome } = excluirLojaSchema.parse(request.body || {});
    const { documento, ...resultado } = await lojaNoAdmin.excluir(request.params.lojaId, confirmacaoNome);
    response.locals.auditoria = { acao: 'excluir_loja', documento, sai: resultado.sai };
    response.json({ data: resultado });
  }));

  router.get('/estabelecimentos/:lojaId/aparencia', asyncHandler(async (request, response) => {
    response.json({ data: await lojaNoAdmin.aparencia(request.params.lojaId) });
  }));

  router.patch('/estabelecimentos/:lojaId/aparencia', asyncHandler(async (request, response) => {
    const entrada = aparenciaSchema.parse(request.body);
    response.locals.auditoria = { acao: 'aparencia', campos: Object.keys(entrada) };
    response.json({ data: await lojaNoAdmin.salvarAparencia(request.params.lojaId, entrada) });
  }));

  router.post('/estabelecimentos/:lojaId/imagens/:tipo', corpoDeImagem, asyncHandler(async (request, response) => {
    const { tipo } = imagemAdminSchema.parse(request.params);
    response.locals.auditoria = { acao: 'imagem', tipo };
    response.json({ data: await lojaNoAdmin.trocarImagem(request.params.lojaId, tipo, request.body) });
  }));

  // Entrega da loja (cola 23.2): leitura e gravacao so dos campos enviados. O registro de quem
  // mudou e quando vai para o adminAuditLogs e AdminAuditLogs da loja, com o valor de antes.
  router.get('/estabelecimentos/:lojaId/entrega', asyncHandler(async (request, response) => {
    response.json({ data: await entregaDaLoja.ler(request.params.lojaId) });
  }));

  router.patch('/estabelecimentos/:lojaId/entrega', asyncHandler(async (request, response) => {
    const entrada = entregaSchema.parse(request.body);
    const resultado = await entregaDaLoja.salvar(request.params.lojaId, entrada);
    response.locals.auditoria = { acao: 'entrega', campos: resultado.campos, antes: resultado.antes };
    response.json({ data: resultado.entrega });
  }));

  // App do cliente da loja (contrato da versao 55, itens 5 e 6; cola RP-13): interruptores
  // (featureFlags) e blocos da Home (aparenciaHome), so pelo Admin.
  router.get('/estabelecimentos/:lojaId/app-do-cliente', asyncHandler(async (request, response) => {
    response.json({ data: await appDoClienteDaLoja.ler(request.params.lojaId) });
  }));

  router.patch('/estabelecimentos/:lojaId/app-do-cliente', asyncHandler(async (request, response) => {
    const entrada = appDoClienteSchema.parse(request.body);
    const resultado = await appDoClienteDaLoja.salvar(request.params.lojaId, entrada);
    response.locals.auditoria = { acao: 'app_do_cliente', campos: resultado.campos, antes: resultado.antes };
    response.json({ data: resultado.app });
  }));

  // Formas de pagamento da loja (item 2), as mesmas regras da rota da loja.
  router.get('/estabelecimentos/:lojaId/formas-de-pagamento', asyncHandler(async (request, response) => {
    response.json({ data: await formasDePagamento.ler(request.params.lojaId) });
  }));

  router.patch('/estabelecimentos/:lojaId/formas-de-pagamento', asyncHandler(async (request, response) => {
    const { formas } = formasDePagamentoSchema.parse(request.body);
    response.locals.auditoria = { acao: 'formas_de_pagamento', campos: Object.keys(formas) };
    response.json({ data: await formasDePagamento.salvar(request.params.lojaId, formas) });
  }));

  router.get('/estabelecimentos/:lojaId/agendamento', asyncHandler(async (request, response) => {
    response.json({ data: await lojaNoAdmin.agendamento(request.params.lojaId) });
  }));

  router.patch('/estabelecimentos/:lojaId/agendamento', asyncHandler(async (request, response) => {
    const { contracted } = agendamentoSchema.parse(request.body);
    response.locals.auditoria = { acao: contracted ? 'agendamento_contratado' : 'agendamento_sem_contrato' };
    response.json({ data: await lojaNoAdmin.contratarAgendamento(request.params.lojaId, contracted) });
  }));

  // ===== Implantacao no Admin (Ficha com seletor de loja) =====
  router.get('/implantacao/:lojaId', asyncHandler(async (request, response) => {
    const loja = await lojaNoAdmin.resumo(request.params.lojaId);
    let pipeline = null;
    try {
      pipeline = await manageImplantationPipelines.get(request.params.lojaId);
    } catch (error) {
      if (error?.code !== 'implantation_pipeline_not_found') throw error;
    }
    response.json({ data: { loja, pipeline } });
  }));

  router.post('/implantacao/:lojaId/app-nas-lojas', asyncHandler(async (request, response) => {
    const { feito } = appNasLojasSchema.parse(request.body);
    response.locals.auditoria = { acao: feito ? 'app_nas_lojas' : 'app_nas_lojas_desfeito' };
    const pipeline = await manageImplantationPipelines.marcarAppNasLojas({
      establishmentId: request.params.lojaId,
      feito,
      uid: request.auth.uid,
    });
    response.json({ data: pipeline });
  }));

  // ===== Franquias =====
  router.get('/franquias', asyncHandler(async (_request, response) => {
    response.json({ data: await franquias.listar() });
  }));

  router.patch('/franquias/:id', asyncHandler(async (request, response) => {
    const entrada = franquiaSchema.parse(request.body);
    const resultado = await franquias.editar(request.params.id, entrada);
    response.locals.auditoria = {
      acao: 'editar_franquia', franquiaId: request.params.id, antes: resultado.antes, depois: resultado.depois,
    };
    response.json({ data: resultado });
  }));

  // ===== Administradores da plataforma =====
  router.get('/administradores', asyncHandler(async (request, response) => {
    response.json({ data: await administradores.listar(atorDe(request)) });
  }));

  router.post('/administradores', asyncHandler(async (request, response) => {
    const entrada = novoAdminSchema.parse(request.body);
    const resultado = await administradores.criar(entrada, atorDe(request));
    response.locals.auditoria = { acao: 'criar_admin', uidNovo: resultado.uid, contaNova: resultado.contaNova };
    response.json({ data: resultado });
  }));

  router.delete('/administradores/:uid', asyncHandler(async (request, response) => {
    response.locals.auditoria = { acao: 'remover_admin', uidRemovido: request.params.uid };
    response.json({ data: await administradores.removerAcesso(request.params.uid, atorDe(request)) });
  }));

  // ===== Dados: Painel de Experiencia pelo Core =====
  router.get('/dados/experiencia', asyncHandler(async (request, response) => {
    const { dias, lojaId } = experienciaSchema.parse(request.query);
    response.json({ data: await dadosDoAdmin.experiencia({ dias, lojaId: lojaId || '' }) });
  }));

  router.get('/dados/experiencia/carrinho/:uid/:lojaId', asyncHandler(async (request, response) => {
    response.json({ data: await dadosDoAdmin.carrinho(request.params.uid, request.params.lojaId) });
  }));

  // ===== Lista padrao =====
  router.get('/:tipo', asyncHandler(async (request, response) => {
    const tipo = tipoDe(request.params.tipo);
    const arquivadas = request.query.arquivadas === 'true';
    response.json({ data: await manageCatalogoPadrao.listar(tipo, { arquivadas }) });
  }));

  router.post('/:tipo', asyncHandler(async (request, response) => {
    const tipo = tipoDe(request.params.tipo);
    const input = criarSchema.parse(request.body);
    response.json({ data: await manageCatalogoPadrao.criar(tipo, input, atorDe(request)) });
  }));

  router.patch('/:tipo/:id', asyncHandler(async (request, response) => {
    const tipo = tipoDe(request.params.tipo);
    const input = editarSchema.parse(request.body);
    response.json({ data: await manageCatalogoPadrao.editar(tipo, request.params.id, input, atorDe(request)) });
  }));

  // Excluir de vez: o Core confere de novo 0 lojas e 0 produtos antes de apagar.
  router.delete('/:tipo/:id', asyncHandler(async (request, response) => {
    const tipo = tipoDe(request.params.tipo);
    response.locals.auditoria = { item: `${tipo}:${request.params.id}`, acao: 'excluir' };
    response.json({ data: await manageCatalogoPadrao.excluir(tipo, request.params.id, atorDe(request)) });
  }));

  router.post('/:tipo/:id/estado', asyncHandler(async (request, response) => {
    const tipo = tipoDe(request.params.tipo);
    const { estado } = estadoSchema.parse(request.body);
    response.json({ data: await manageCatalogoPadrao.mudarEstado(tipo, request.params.id, estado, atorDe(request)) });
  }));

  router.get('/:tipo/:id/impacto', asyncHandler(async (request, response) => {
    const tipo = tipoDe(request.params.tipo);
    response.json({ data: await manageCatalogoPadrao.impacto(tipo, request.params.id) });
  }));

  router.post('/:tipo/:id/levar-nome', asyncHandler(async (request, response) => {
    const tipo = tipoDe(request.params.tipo);
    const result = await manageCatalogoPadrao.levarNome(tipo, request.params.id);
    response.locals.lojasAlvo = result.atualizadas;
    response.locals.auditoria = { item: `${tipo}:${request.params.id}`, nomeAntigo: result.nomeAntigo, nomeNovo: result.nomeNovo };
    response.json({ data: result });
  }));

  router.post('/categorias/:id/icone', asyncHandler(async (request, response) => {
    const input = iconeSchema.parse(request.body);
    response.json({ data: await manageCatalogoPadrao.trocarIcone(request.params.id, input, atorDe(request)) });
  }));

  router.get('/categorias/:id/liberacoes', asyncHandler(async (request, response) => {
    response.json({ data: await manageCatalogoPadrao.liberacoes(request.params.id) });
  }));

  return router;
}
