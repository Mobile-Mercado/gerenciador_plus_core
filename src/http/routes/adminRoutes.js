import { Router } from 'express';
import { z } from 'zod';
import { formatarNome } from '../../domain/catalogo/formatarNome.js';
import { asyncHandler } from '../middlewares/asyncHandler.js';

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

const tipoDe = (plural) => (tipoSchema.parse(plural) === 'categorias' ? 'categoria' : 'subcategoria');
const atorDe = (request) => ({ uid: request.auth?.uid || null, email: request.auth?.email || null });

const sugestoesClientesSchema = z.object({
  lojaId: z.string().min(1).max(120).optional(),
  busca: z.string().max(200).optional(),
  cursor: z.string().min(1).max(400).optional(),
});

export function createAdminRoutes({ manageCatalogoPadrao, sugestoesDosClientes }) {
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
