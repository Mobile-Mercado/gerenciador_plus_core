import { Router } from 'express';
import { z } from 'zod';
import { formatarNome } from '../../domain/catalogo/formatarNome.js';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { corpoDeImagem } from '../middlewares/corpoDeImagem.js';
import { appDoClienteSchema, formasDePagamentoSchema } from './appDoClienteSchema.js';
import {
  afetadasSchema, alterarBannerSchema, animacaoPadraoSchema, coresPadraoSchema, alterarModeloSchema, alvoDoArquivoSchema, aparenciaDaLojaSchema, arquivoDaAparenciaSchema,
  bannerParamsSchema, conjuntoDaLojaSchema, conjuntoNomeSchema, iconeComIaSchema, iconeDoConjuntoSchema, modelosConsultaSchema, novoBannerSchema,
  novoModeloSchema, padraoSchema, variacaoParamsSchema, voltarAoOriginalSchema,
} from './aparenciaSchema.js';
import { entregaSchema } from './entregaSchema.js';
import { AMBIENTES_DA_SAFRA } from '../../application/loja/FormasDePagamento.js';

// Rotas do Admin da plataforma. A barreira (requirePlatformAdmin) e o registro de quem agiu
// (adminAudit) entram em app.js, antes deste roteador. Nao existe rota de excluir: item
// retirado da lista padrao e arquivado.

const tipoSchema = z.enum(['categorias', 'subcategorias']);
// Contrato K4 (cola RP-62, item A.2): credencial da Safrapay da loja, gravada pelo Admin.
const credencialDaSafraSchema = z.object({
  ambiente: z.enum(AMBIENTES_DA_SAFRA),
  merchantId: z.string().trim().min(1).max(200),
  merchantToken: z.string().trim().min(1).max(4096),
}).strict();
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
// Dono da loja (RP-67, B.1 e B.2): sem e-mail, userReference para o Users do dono; com e-mail,
// a conta nova. O e-mail vai no corpo, nunca na rota, e nao entra no registro do Admin.
const donoSchema = z.object({ email: z.string().trim().min(1).max(320).optional() }).strict();
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
  discountBadgeColor: z.string().max(7).nullable().optional(),
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
const atorDoAlerta = (request) => ({ ...atorDe(request), nome: request.auth?.name || null });

const lojaDoIntegradorSchema = z.object({ establishmentId: z.string().trim().min(1).max(120).regex(/^[^/]+$/) });
// Item 5.10 "Acessos conectados".
const acessoParamsSchema = z.object({ establishmentId: lojaDoIntegradorSchema.shape.establishmentId, sessaoId: z.string().max(64) });
const ipDoAcessoSchema = z.object({ ip: z.string().trim().min(1).max(64) });
const nomeDoIpSchema = z.object({ ip: z.string().trim().min(1).max(64), nome: z.string().max(200).nullable() });
const nomeDoAcessoSchema = z.object({ nome: z.string().max(200).nullable() });

const sugestoesClientesSchema = z.object({
  lojaId: z.string().min(1).max(120).optional(),
  busca: z.string().max(200).optional(),
  cursor: z.string().min(1).max(400).optional(),
});

// Cola B57-13k, item 34: nomes dos blocos da Home no registro do "So na {loja}".
const NOMES_DOS_BLOCOS_DA_HOME = Object.freeze({ topo: 'Topo', meio: 'Meio', fim: 'Fim' });

export function createAdminRoutes({
  manageCatalogoPadrao, sugestoesDosClientes, pedidosDeLoja, lojaNoAdmin, franquias, administradores, dadosDoAdmin,
  manageImplantationPipelines, jornadaDeEntrada = null, entregaDaLoja = null, appDoClienteDaLoja = null,
  formasDePagamento = null, instalacoesDosApps = null, conjuntosDeIcones = null, iconesComIa = null, aparenciaDaLoja = null,
  aparenciaDaHome = null, bannersNoAdmin = null, alertasDoAdmin = null, integradorDaLoja = null, sessoesWeb = null,
}) {
  const router = Router();

  // ===== Integrador da loja (cola 65, item 4.11; contrato D:erramentas-integradorcontrato-4.11-4.6.md) =====
  // "Trocar o computador do integrador": libera o proximo computador que abrir o integrador da loja
  // (grava trocaLiberadaEm e trocaLiberadaPor em estabelecimentos/{loja}/IntegradorDaLoja/atual).
  // A loja vai para o registro de auditoria da loja (adminAudit le response.locals.lojasAlvo).
  if (integradorDaLoja) {
    // Cola 70, item 1: card "Computador do integrador" na loja aberta (so leitura).
    router.get('/lojas/:establishmentId/integrador', asyncHandler(async (request, response) => {
      const { establishmentId } = lojaDoIntegradorSchema.parse(request.params);
      response.json({ data: await integradorDaLoja.computador({ establishmentId }) });
    }));
    router.post('/lojas/:establishmentId/integrador/trocar-computador', asyncHandler(async (request, response) => {
      const { establishmentId } = lojaDoIntegradorSchema.parse(request.params);
      response.locals.lojasAlvo = [establishmentId];
      response.locals.auditoria = { acao: 'integrador_trocar_computador' };
      response.json({ data: await integradorDaLoja.trocarComputador({ establishmentId, adminUid: request.auth?.uid }) });
    }));
  }

  // ===== Acessos conectados (item 5.10; plano construcao-acessos-conectados.md) =====
  // Estabelecimentos > loja > "Acessos conectados": lista por IP, "Sair" por navegador, "Sair de todos
  // deste IP", "Sair de todos", nome do navegador e do IP. Toda acao que grava entra no adminAuditLogs
  // e no AdminAuditLogs da loja (adminAudit le response.locals.lojasAlvo e auditoria), com quem e quando.
  if (sessoesWeb) {
    const registrar = (response, establishmentId, auditoria) => {
      response.locals.lojasAlvo = [establishmentId];
      response.locals.auditoria = auditoria;
    };
    router.get('/lojas/:establishmentId/acessos', asyncHandler(async (request, response) => {
      const { establishmentId } = lojaDoIntegradorSchema.parse(request.params);
      response.json({ data: await sessoesWeb.listar({ lojaId: establishmentId }) });
    }));
    router.post('/lojas/:establishmentId/acessos/sair-de-todos', asyncHandler(async (request, response) => {
      const { establishmentId } = lojaDoIntegradorSchema.parse(request.params);
      registrar(response, establishmentId, { acao: 'acessos_sair_de_todos' });
      response.json({ data: await sessoesWeb.encerrarTodas({ lojaId: establishmentId, adminUid: request.auth?.uid || null }) });
    }));
    router.post('/lojas/:establishmentId/acessos/sair-do-ip', asyncHandler(async (request, response) => {
      const { establishmentId } = lojaDoIntegradorSchema.parse(request.params);
      const { ip } = ipDoAcessoSchema.parse(request.body ?? {});
      registrar(response, establishmentId, { acao: 'acessos_sair_do_ip', ip });
      response.json({ data: await sessoesWeb.encerrarDoIp({ lojaId: establishmentId, ip, adminUid: request.auth?.uid || null }) });
    }));
    router.put('/lojas/:establishmentId/acessos/ips', asyncHandler(async (request, response) => {
      const { establishmentId } = lojaDoIntegradorSchema.parse(request.params);
      const { ip, nome } = nomeDoIpSchema.parse(request.body ?? {});
      registrar(response, establishmentId, { acao: 'acessos_nomear_ip', ip, nome });
      response.json({ data: await sessoesWeb.nomearIp({ lojaId: establishmentId, ip, nome, adminUid: request.auth?.uid || null }) });
    }));
    router.post('/lojas/:establishmentId/acessos/:sessaoId/sair', asyncHandler(async (request, response) => {
      const { establishmentId, sessaoId } = acessoParamsSchema.parse(request.params);
      registrar(response, establishmentId, { acao: 'acessos_sair', sessaoId });
      response.json({ data: await sessoesWeb.encerrar({ lojaId: establishmentId, sessaoId, adminUid: request.auth?.uid || null }) });
    }));
    router.patch('/lojas/:establishmentId/acessos/:sessaoId', asyncHandler(async (request, response) => {
      const { establishmentId, sessaoId } = acessoParamsSchema.parse(request.params);
      const { nome } = nomeDoAcessoSchema.parse(request.body ?? {});
      registrar(response, establishmentId, { acao: 'acessos_renomear', sessaoId, nome });
      response.json({ data: await sessoesWeb.renomear({ lojaId: establishmentId, sessaoId, nome }) });
    }));
  }

  // ===== Alertas (cola B57-03, D1 e D2, e B57-03c, item 8) =====
  // A aba le os alertas e as conferencias; ao abrir, roda as conferencias automaticas que passaram
  // de 10 minutos (sem agenda publicada). "Marcar como resolvido" e "Conferi agora" gravam quem e
  // quando, so nas colecoes da aba.
  if (alertasDoAdmin) {
    router.get('/alertas', asyncHandler(async (request, response) => {
      const lista = z.enum(['abertos', 'resolvidos', 'todos']).catch('abertos').parse(request.query.lista);
      await alertasDoAdmin.conferir().catch(() => null);
      const [alertas, conferencias] = await Promise.all([alertasDoAdmin.listar(lista), alertasDoAdmin.listaDeConferencias()]);
      response.json({ data: { ...alertas, conferencias } });
    }));
    router.get('/alertas/abertos', asyncHandler(async (_request, response) => {
      response.json({ data: { abertos: await alertasDoAdmin.quantidadeDeAbertos() } });
    }));
    router.post('/alertas/:id/resolver', asyncHandler(async (request, response) => {
      response.json({ data: await alertasDoAdmin.resolver(request.params.id, atorDoAlerta(request)) });
    }));
    router.post('/alertas/conferencias/:chave/conferi', asyncHandler(async (request, response) => {
      response.json({ data: await alertasDoAdmin.conferiAgora(request.params.chave, atorDoAlerta(request)) });
    }));
  }

  // ===== Instalacoes dos apps (tela Instalacoes, 16/10/2026) =====
  // Leitura: os Stats/instalacoesApp das lojas com app, uma leitura por loja, quando a tela abre.
  // "Atualizar agora": a mesma montagem da rotina semanal; um clique por vez (409 se ja esta rodando).
  if (instalacoesDosApps) {
    router.get('/instalacoes', asyncHandler(async (_request, response) => {
      response.json({ data: await instalacoesDosApps.listar() });
    }));
    router.post('/instalacoes/atualizar', asyncHandler(async (_request, response) => {
      response.json({ data: await instalacoesDosApps.atualizar() });
    }));
  }

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
    response.json({ data: await lojaNoAdmin.resumoComDono(request.params.lojaId) });
  }));

  router.get('/estabelecimentos/:lojaId/contas', asyncHandler(async (request, response) => {
    response.json({ data: await lojaNoAdmin.contas(request.params.lojaId) });
  }));

  // Corrigir acesso (RP-67, B.4): registro do Admin so com uid, loja e o que mudou (sem e-mail).
  router.post('/estabelecimentos/:lojaId/contas/:uid/acesso/previa', asyncHandler(async (request, response) => {
    response.locals.auditoria = { acao: 'previa_do_acesso', email: null };
    response.json({ data: await lojaNoAdmin.previaDoAcesso(request.params.lojaId, request.params.uid) });
  }));

  // Corrigir acesso: a claim antiga fica guardada no adminAuditLogs.
  router.post('/estabelecimentos/:lojaId/contas/:uid/acesso', asyncHandler(async (request, response) => {
    response.locals.auditoria = { acao: 'corrigir_acesso', email: null };
    const resultado = await lojaNoAdmin.corrigirAcesso(request.params.lojaId, request.params.uid);
    response.locals.auditoria = {
      acao: 'corrigir_acesso',
      email: null,
      uidConta: request.params.uid,
      claimsAntigas: resultado.claimsAntigas,
      claimsNovas: resultado.claimsNovas,
    };
    response.json({ data: resultado });
  }));

  // Dono da loja (RP-67, B.1 e B.2). Registro do Admin so com uid, loja e o que mudou: sem o
  // e-mail digitado e sem o e-mail de quem agiu (email: null por cima do adminAudit).
  router.get('/estabelecimentos/:lojaId/dono', asyncHandler(async (request, response) => {
    response.json({ data: await lojaNoAdmin.situacaoDoDono(request.params.lojaId) });
  }));

  router.post('/estabelecimentos/:lojaId/dono/previa', asyncHandler(async (request, response) => {
    response.locals.auditoria = { acao: 'previa_do_dono', email: null };
    const entrada = donoSchema.parse(request.body || {});
    response.json({ data: await lojaNoAdmin.previaDoDono(request.params.lojaId, entrada) });
  }));

  router.post('/estabelecimentos/:lojaId/dono', asyncHandler(async (request, response) => {
    const acao = request.body?.email !== undefined ? 'ligar_conta_nova_do_dono' : 'corrigir_user_reference';
    response.locals.auditoria = { acao, email: null };
    const entrada = donoSchema.parse(request.body || {});
    const resultado = await lojaNoAdmin.ligarDono(request.params.lojaId, entrada);
    response.locals.auditoria = {
      acao,
      email: null,
      uidConta: resultado.uid,
      uidAntigo: resultado.uidAntigo,
      userReferenceAntes: resultado.userReferenceAntes,
      userReferenceDepois: resultado.userReferenceDepois,
      ...(resultado.claimsNovas ? { claimsAntigas: resultado.claimsAntigas, claimsNovas: resultado.claimsNovas } : {}),
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
    // Cola B57-13k, item 34 (b): "So na {loja}" (Admin > Aparencias > Home, ?soNaLoja=topo|meio|fim)
    // entra no registro do Admin como "Salvou só na {loja}", com o nome do bloco.
    const pedido = String(request.query?.soNaLoja || '');
    const bloco = Object.hasOwn(NOMES_DOS_BLOCOS_DA_HOME, pedido) ? NOMES_DOS_BLOCOS_DA_HOME[pedido] : null;
    response.locals.auditoria = bloco
      ? { acao: 'so_na_loja', descricao: `Salvou só na ${resultado.nomeDaLoja}`, bloco, campos: resultado.campos, antes: resultado.antes }
      : { acao: 'app_do_cliente', campos: resultado.campos, antes: resultado.antes };
    response.json({ data: resultado.app });
  }));

  // Formas de pagamento da loja (item 2), as mesmas regras da rota da loja.
  router.get('/estabelecimentos/:lojaId/formas-de-pagamento', asyncHandler(async (request, response) => {
    response.json({ data: await formasDePagamento.ler(request.params.lojaId) });
  }));

  router.patch('/estabelecimentos/:lojaId/formas-de-pagamento', asyncHandler(async (request, response) => {
    const { formas, entrega } = formasDePagamentoSchema.parse(request.body);
    response.locals.auditoria = {
      acao: 'formas_de_pagamento', campos: [...Object.keys(formas || {}), ...(typeof entrega === 'boolean' ? ['entrega'] : [])],
    };
    response.json({ data: await formasDePagamento.salvar(request.params.lojaId, formas, { entrega }) });
  }));

  // ===== Credencial da Safrapay (contrato K4, cola RP-62, item A.2) =====
  // Salvar liga a Safra na loja e apagar desliga. A resposta e a auditoria nunca levam merchantId
  // nem merchantToken: so gateway, ambiente, quando e quem salvou.
  router.get('/estabelecimentos/:lojaId/safrapay', asyncHandler(async (request, response) => {
    response.json({ data: await formasDePagamento.credencialNoAdmin(request.params.lojaId) });
  }));

  router.put('/estabelecimentos/:lojaId/safrapay', asyncHandler(async (request, response) => {
    const entrada = credencialDaSafraSchema.parse(request.body);
    const ator = { uid: request.auth?.uid || null, nome: request.auth?.name || request.auth?.email || null };
    response.locals.auditoria = { acao: 'credencial_safrapay_salva', ambiente: entrada.ambiente };
    response.json({ data: await formasDePagamento.salvarCredencial(request.params.lojaId, entrada, ator) });
  }));

  router.delete('/estabelecimentos/:lojaId/safrapay', asyncHandler(async (request, response) => {
    response.locals.auditoria = { acao: 'credencial_safrapay_apagada' };
    response.json({ data: await formasDePagamento.apagarCredencial(request.params.lojaId) });
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

  // ===== Aparencias (cola B56-04) =====
  // Conjuntos de icones: "Lineares" (a lista padrao) vem primeiro, com o numero de lojas de cada.
  if (conjuntosDeIcones) {
    router.get('/conjuntos-icones', asyncHandler(async (_request, response) => {
      response.json({ data: await conjuntosDeIcones.listar() });
    }));

    router.get('/conjuntos-icones/:conjuntoId', asyncHandler(async (request, response) => {
      response.json({ data: await conjuntosDeIcones.ler(request.params.conjuntoId) });
    }));

    router.post('/conjuntos-icones', asyncHandler(async (request, response) => {
      const { nome } = conjuntoNomeSchema.parse(request.body);
      const conjunto = await conjuntosDeIcones.criar({ nome }, atorDe(request));
      response.locals.auditoria = { acao: 'conjunto_icones_criado', conjuntoId: conjunto.id, nome: conjunto.nome };
      response.status(201).json({ data: conjunto });
    }));

    // Criador de icones com IA (Thay, 27/11): gera o icone de uma categoria e devolve a imagem; o
    // Admin grava pela troca de icone so no "Salvar conjunto".
    if (iconesComIa) {
      router.post('/conjuntos-icones/gerar', asyncHandler(async (request, response) => {
        const entrada = iconeComIaSchema.parse(request.body);
        const resultado = await iconesComIa.gerar(entrada, atorDe(request));
        response.locals.auditoria = {
          acao: 'icone_gerado_com_ia', categoriaId: entrada.categoriaId, conjuntoId: entrada.conjuntoId, qualidade: entrada.qualidade, custoUsd: resultado.custoUsd,
        };
        response.json({ data: resultado });
      }));
    }

    router.patch('/conjuntos-icones/:conjuntoId', asyncHandler(async (request, response) => {
      const { nome } = conjuntoNomeSchema.parse(request.body);
      const resultado = await conjuntosDeIcones.renomear(request.params.conjuntoId, { nome }, atorDe(request));
      response.locals.auditoria = {
        acao: 'conjunto_icones_renomeado', conjuntoId: request.params.conjuntoId, antes: resultado.antes, depois: resultado.conjunto.nome,
      };
      response.json({ data: resultado.conjunto });
    }));

    // Colecao padrao, para a loja sem escolha (cola B56-17): so uma por vez.
    router.put('/conjuntos-icones/:conjuntoId/padrao', asyncHandler(async (request, response) => {
      const resultado = await conjuntosDeIcones.marcarPadrao(request.params.conjuntoId, atorDe(request));
      response.locals.auditoria = { acao: 'conjunto_icones_padrao', conjuntoId: request.params.conjuntoId, antes: resultado.antes };
      response.json({ data: resultado.conjunto });
    }));

    router.put('/conjuntos-icones/:conjuntoId/icones/:categoriaId', asyncHandler(async (request, response) => {
      const entrada = iconeDoConjuntoSchema.parse(request.body);
      const { conjuntoId, categoriaId } = request.params;
      const resultado = await conjuntosDeIcones.trocarIcone(conjuntoId, categoriaId, entrada, atorDe(request));
      response.locals.auditoria = {
        acao: 'conjunto_icone_trocado', conjuntoId, categoriaId, antes: resultado.antes?.arquivo || null, convertido: resultado.convertido,
      };
      response.json({ data: resultado.conjunto });
    }));

    // Baixar o icone (Thay, 28/11): so leitura, sem auditoria.
    router.get('/conjuntos-icones/:conjuntoId/icones/:categoriaId/arquivo', asyncHandler(async (request, response) => {
      const { conteudo, contentType } = await conjuntosDeIcones.arquivoDoIcone(request.params.conjuntoId, request.params.categoriaId);
      response.set('Content-Type', contentType);
      response.set('Cache-Control', 'no-store');
      response.send(conteudo);
    }));

    router.delete('/conjuntos-icones/:conjuntoId/icones/:categoriaId', asyncHandler(async (request, response) => {
      const { conjuntoId, categoriaId } = request.params;
      const resultado = await conjuntosDeIcones.removerIcone(conjuntoId, categoriaId, atorDe(request));
      response.locals.auditoria = { acao: 'conjunto_icone_removido', conjuntoId, categoriaId, antes: resultado.antes?.arquivo || null };
      response.json({ data: resultado.conjunto });
    }));

    // Conjunto da loja: null ou "lineares" volta para a lista padrao.
    router.get('/estabelecimentos/:lojaId/conjunto-icones', asyncHandler(async (request, response) => {
      response.json({ data: await conjuntosDeIcones.daLoja(request.params.lojaId) });
    }));

    router.patch('/estabelecimentos/:lojaId/conjunto-icones', asyncHandler(async (request, response) => {
      const { conjuntoId } = conjuntoDaLojaSchema.parse(request.body);
      const resultado = await conjuntosDeIcones.escolherDaLoja(request.params.lojaId, conjuntoId);
      response.locals.auditoria = {
        acao: 'conjunto_icones_da_loja', campos: ['aparencia.conjuntoIcones'], antes: resultado.antes, depois: resultado.conjuntoIcones,
      };
      response.json({ data: resultado });
    }));
  }

  // Variacoes da Inicio (cola B56-08, B4): tabela, modelos, padroes e quantas lojas cada gravacao
  // muda. Modelo e padrao gravam na hora e regravam as lojas afetadas (lojasAlvo na auditoria).
  if (aparenciaDaHome) {
    router.get('/aparencia-home/variacoes', asyncHandler(async (_request, response) => {
      response.json({ data: await aparenciaDaHome.variacoes() });
    }));

    router.get('/aparencia-home/afetadas', asyncHandler(async (request, response) => {
      const { bloco, numero, modelo } = afetadasSchema.parse(request.query);
      response.json({ data: await aparenciaDaHome.afetadas({ bloco, numero, modeloId: modelo }) });
    }));

    router.get('/modelos-aparencia', asyncHandler(async (request, response) => {
      const { bloco } = modelosConsultaSchema.parse(request.query);
      response.json({ data: await aparenciaDaHome.listarModelos(bloco || null) });
    }));

    router.post('/modelos-aparencia', asyncHandler(async (request, response) => {
      const entrada = novoModeloSchema.parse(request.body);
      const modelo = await aparenciaDaHome.criarModelo(entrada, atorDe(request));
      response.locals.auditoria = { acao: 'modelo_aparencia_criado', modeloId: modelo.id, bloco: modelo.bloco, base: modelo.base, nome: modelo.nome };
      response.status(201).json({ data: modelo });
    }));

    router.patch('/modelos-aparencia/:modeloId', asyncHandler(async (request, response) => {
      const entrada = alterarModeloSchema.parse(request.body);
      const resultado = await aparenciaDaHome.salvarModelo(request.params.modeloId, entrada, atorDe(request));
      response.locals.lojasAlvo = resultado.lojas;
      response.locals.auditoria = {
        acao: 'modelo_aparencia_salvo', modeloId: request.params.modeloId, antes: resultado.antes, lojasAlteradas: resultado.lojasAlteradas,
      };
      response.json({ data: { modelo: resultado.modelo, lojasAlteradas: resultado.lojasAlteradas } });
    }));

    router.put('/aparencia-padrao/:bloco/:numero', asyncHandler(async (request, response) => {
      const { bloco, numero } = variacaoParamsSchema.parse(request.params);
      const { ajustes, incluirAjusteProprio = false } = padraoSchema.parse(request.body);
      const resultado = await aparenciaDaHome.mudarPadrao(bloco, numero, ajustes, atorDe(request), { incluirAjusteProprio });
      response.locals.lojasAlvo = resultado.lojas;
      response.locals.auditoria = {
        acao: 'padrao_aparencia_mudado', bloco, numero, antes: resultado.antes, lojasAlteradas: resultado.lojasAlteradas,
        incluirAjusteProprio, lojasComAjusteProprio: resultado.lojasComAjusteProprio,
      };
      response.json({ data: { bloco, numero, ajustes: resultado.ajustes, lojasAlteradas: resultado.lojasAlteradas, lojasComAjusteProprio: resultado.lojasComAjusteProprio } });
    }));

    router.delete('/aparencia-padrao/:bloco/:numero', asyncHandler(async (request, response) => {
      const { bloco, numero } = variacaoParamsSchema.parse(request.params);
      const incluirAjusteProprio = voltarAoOriginalSchema.parse(request.query).incluirAjusteProprio === 'true';
      const resultado = await aparenciaDaHome.voltarAoOriginal(bloco, numero, atorDe(request), { incluirAjusteProprio });
      response.locals.lojasAlvo = resultado.lojas;
      response.locals.auditoria = {
        acao: 'padrao_aparencia_original', bloco, numero, antes: resultado.antes, lojasAlteradas: resultado.lojasAlteradas,
        incluirAjusteProprio, lojasComAjusteProprio: resultado.lojasComAjusteProprio,
      };
      response.json({ data: { bloco, numero, ajustes: resultado.ajustes, lojasAlteradas: resultado.lojasAlteradas, lojasComAjusteProprio: resultado.lojasComAjusteProprio } });
    }));
  }

  // Banners da loja pelo Admin (cola B56-08, B5): o corpo do envio e a imagem; tipo e periodo na consulta.
  if (bannersNoAdmin) {
    router.get('/estabelecimentos/:lojaId/banners', asyncHandler(async (request, response) => {
      response.json({ data: await bannersNoAdmin.listar(request.params.lojaId) });
    }));

    router.post('/estabelecimentos/:lojaId/banners', corpoDeImagem, asyncHandler(async (request, response) => {
      const { tipo, inicio, fim } = novoBannerSchema.parse(request.query);
      const banner = await bannersNoAdmin.criar(request.params.lojaId, tipo, request.body, request.headers['content-type'], { inicio, fim });
      response.locals.auditoria = { acao: 'banner_criado', bannerId: banner.id, tipo };
      response.status(201).json({ data: banner });
    }));

    router.put('/estabelecimentos/:lojaId/banners/:bannerId/imagem', corpoDeImagem, asyncHandler(async (request, response) => {
      const { lojaId, bannerId } = bannerParamsSchema.parse(request.params);
      const resultado = await bannersNoAdmin.trocarImagem(lojaId, bannerId, request.body, request.headers['content-type']);
      response.locals.auditoria = { acao: 'banner_imagem_trocada', bannerId, antes: resultado.antes };
      response.json({ data: resultado.banner });
    }));

    router.patch('/estabelecimentos/:lojaId/banners/:bannerId', asyncHandler(async (request, response) => {
      const { lojaId, bannerId } = bannerParamsSchema.parse(request.params);
      const entrada = alterarBannerSchema.parse(request.body);
      const resultado = await bannersNoAdmin.alterar(lojaId, bannerId, entrada);
      response.locals.auditoria = { acao: 'banner_alterado', bannerId, campos: resultado.campos, antes: resultado.antes };
      response.json({ data: resultado.banner });
    }));

    router.delete('/estabelecimentos/:lojaId/banners/:bannerId', asyncHandler(async (request, response) => {
      const { lojaId, bannerId } = bannerParamsSchema.parse(request.params);
      const resultado = await bannersNoAdmin.apagar(lojaId, bannerId);
      response.locals.auditoria = { acao: 'banner_apagado', bannerId, antes: resultado.antes };
      response.json({ data: resultado });
    }));
  }

  // Ofertas, Abertura e Primeira tela da loja, com o valor de antes na auditoria.
  if (aparenciaDaLoja) {
    router.get('/estabelecimentos/:lojaId/aparencias', asyncHandler(async (request, response) => {
      response.json({ data: await aparenciaDaLoja.ler(request.params.lojaId) });
    }));

    router.patch('/estabelecimentos/:lojaId/aparencias', asyncHandler(async (request, response) => {
      const entrada = aparenciaDaLojaSchema.parse(request.body);
      const resultado = await aparenciaDaLoja.salvar(request.params.lojaId, entrada);
      response.locals.auditoria = { acao: 'aparencias', campos: resultado.campos, antes: resultado.antes };
      response.json({ data: resultado.aparencia });
    }));

    router.post('/estabelecimentos/:lojaId/aparencias/arquivos/:alvo', asyncHandler(async (request, response) => {
      const alvo = alvoDoArquivoSchema.parse(request.params.alvo);
      const entrada = arquivoDaAparenciaSchema.parse(request.body);
      const resultado = await aparenciaDaLoja.enviarArquivo(request.params.lojaId, alvo, entrada);
      response.locals.auditoria = { acao: 'aparencias_arquivo', alvo, campos: resultado.campos, antes: resultado.antes };
      response.json({ data: resultado.aparencia });
    }));

    // Cola B56-24 (A2): animacao padrao da Abertura de todas as lojas. O GET da os numeros da
    // janela de confirmacao ("vale para N lojas", "as M lojas com animacao propria").
    router.get('/aparencia-padrao-abertura', asyncHandler(async (_request, response) => {
      response.json({ data: await aparenciaDaLoja.padraoDaAbertura() });
    }));

    // Cola B56-25 (item 7): cores com que as lojas novas nascem (loja = primaryColor, sistema =
    // secondaryColor). As lojas que ja existem nao mudam.
    router.get('/aparencia-padrao-cores', asyncHandler(async (_request, response) => {
      response.json({ data: await aparenciaDaLoja.coresPadrao() });
    }));

    router.put('/aparencia-padrao-cores', asyncHandler(async (request, response) => {
      const entrada = coresPadraoSchema.parse(request.body);
      const { antes, ...depois } = await aparenciaDaLoja.mudarCoresPadrao(entrada, atorDe(request));
      response.locals.auditoria = { acao: 'cores_padrao_lojas_novas', antes, depois };
      response.json({ data: depois });
    }));

    router.put('/aparencia-padrao-abertura', asyncHandler(async (request, response) => {
      const { incluirAnimacaoPropria = false, ...arquivo } = animacaoPadraoSchema.parse(request.body);
      const resultado = await aparenciaDaLoja.trocarAnimacaoPadrao(arquivo, atorDe(request), { incluirAnimacaoPropria });
      response.locals.auditoria = {
        acao: 'animacao_padrao_abertura', nome: resultado.nome, antes: resultado.antes,
        lojasAlteradas: resultado.lojasAlteradas, lojasLimpas: resultado.lojasLimpas, incluirAnimacaoPropria,
      };
      const { lojasLimpas: _limpas, antes: _antes, ...dados } = resultado;
      response.json({ data: dados });
    }));
  }

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
