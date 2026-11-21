import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';

const historicoParamsSchema = z.object({ productId: z.string().trim().min(1).max(200).regex(/^[^/]+$/) });
const historicoQuerySchema = z.object({ limite: z.coerce.number().int().min(1).max(200).optional() });
const grupoParamsSchema = z.object({ grupo: z.string().trim().min(1).max(60).regex(/^[A-Za-z]+$/) });
const grupoQuerySchema = z.object({ limite: z.coerce.number().int().min(1).max(100).optional() });

// Produtos da propria loja (cola 65, item 3.5). A loja vem da conta da requisicao
// (accountForRequest): dono, funcionario com adminOf ou Admin da plataforma na loja escolhida
// (X-Loja-Alvo). Leitura, sem chave de permissao, como as leituras do proxy de dados.
export function createProdutosRoutes({ historicoDoProduto, produtosForaDoApp = null, accountForRequest }) {
  const router = Router();

  // Painel "Produtos fora do app" (cola 65, item 5.1): o resumo numa rota so e o "Ver todos" de
  // cada grupo. Resposta: { data: { faixa, resumo, grupos, arquivosSeparados } } e
  // { data: { chave, quantidade, produtos } }. Vem antes de /:productId para nao virar um produto.
  if (produtosForaDoApp) {
    router.get(
      '/fora-do-app',
      asyncHandler(async (request, response) => {
        const ator = await accountForRequest(request);
        response.json({ data: await produtosForaDoApp.resumo({ ator }) });
      }),
    );
    router.get(
      '/fora-do-app/:grupo',
      asyncHandler(async (request, response) => {
        const { grupo } = grupoParamsSchema.parse(request.params);
        const { limite } = grupoQuerySchema.parse(request.query);
        const ator = await accountForRequest(request);
        response.json({ data: await produtosForaDoApp.doGrupo({ ator, chave: grupo, limite }) });
      }),
    );
  }

  // Historico do produto: linhas do Log (AcoesEquipe) com o produto como alvo, da mais nova
  // para a mais antiga. Resposta: { data: { produtoId, completo, linhas: [{ id, quando, quem,
  // origem, origemGravada, acao, tela, campos: [{ campo, antes, depois }] }] } }.
  router.get(
    '/:productId/historico',
    asyncHandler(async (request, response) => {
      const { productId } = historicoParamsSchema.parse(request.params);
      const { limite } = historicoQuerySchema.parse(request.query);
      const ator = await accountForRequest(request);
      response.json({ data: await historicoDoProduto.listar({ ator, produtoId: productId, limite }) });
    }),
  );

  return router;
}
