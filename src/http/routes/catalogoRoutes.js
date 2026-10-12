import { Router } from 'express';
import { z } from 'zod';
import { formatarNome } from '../../domain/catalogo/formatarNome.js';
import { asyncHandler } from '../middlewares/asyncHandler.js';

// Catalogo da loja a partir da lista padrao: o que pode ativar, Ativar, categorias
// travadas e nome de exibicao. A loja vem da sessao, nunca do corpo.

const ativarSchema = z.object({
  tipo: z.enum(['categoria', 'subcategoria']),
  id: z.string().min(1).max(120),
});
const nomeSchema = z.object({
  tipo: z.enum(['categoria', 'subcategoria']),
  id: z.string().min(1).max(120),
  nome: z.string().max(80),
});
const formatarSchema = z.object({ nome: z.string().max(200) });

export function createCatalogoRoutes({ catalogoDaLoja, requirePermission, accountForRequest }) {
  const router = Router();
  const ator = async (request) => ({ uid: request.auth?.uid || null, ...(await accountForRequest(request)) });

  // Previa do formatador para a tela, sem gravar.
  router.post('/formatar-nome', (request, response) => {
    const { nome } = formatarSchema.parse(request.body);
    response.json({ data: { nome: formatarNome(nome) } });
  });

  router.get('/travadas', asyncHandler(async (request, response) => {
    response.json({ data: await catalogoDaLoja.travadas(await ator(request)) });
  }));

  router.get('/padrao-disponivel', asyncHandler(async (request, response) => {
    response.json({ data: await catalogoDaLoja.padraoDisponivel(await ator(request)) });
  }));

  router.post('/ativar', requirePermission('products.edit'), asyncHandler(async (request, response) => {
    const input = ativarSchema.parse(request.body);
    response.json({ data: await catalogoDaLoja.ativar(await ator(request), input) });
  }));

  router.post('/nome-exibicao', requirePermission('products.edit'), asyncHandler(async (request, response) => {
    const input = nomeSchema.parse(request.body);
    response.json({ data: await catalogoDaLoja.nomeDeExibicao(await ator(request), input) });
  }));

  return router;
}
