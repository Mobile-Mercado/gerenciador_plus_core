import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';
import { origemDoCabecalho } from '../../domain/logs/origemDaAcao.js';
import { TAMANHO_DO_TEXTO } from '../../domain/loja/motivosDaSeparacao.js';
import { nomeDoComputadorNaLoja } from '../../infra/firebase/nomeDoComputador.js';

// Motivos da separacao da loja da sessao (cola do Thay B57-16b, item 11; contrato
// Documentos/rodada-paralela/B57-16b-contrato-motivos.md):
// - GET /?tipo=troca|remocao|todos: a lista na ordem de uso (chips do App Gerenciador e tabela do web);
// - POST /uso: ao concluir a separacao, soma o uso e salva o motivo novo marcado (App Gerenciador);
// - POST /, PATCH /:id, DELETE /:id: criar, editar e apagar (web), com o Log da equipe e a origem (X-Origem).
const tipoSchema = z.object({ tipo: z.enum(['troca', 'remocao', 'todos']).optional() });
const texto = z.string().max(TAMANHO_DO_TEXTO * 2);
const criarSchema = z.object({ texto, troca: z.boolean(), remocao: z.boolean() });
const editarSchema = z.object({ texto: texto.optional(), troca: z.boolean().optional(), remocao: z.boolean().optional() })
  .refine((corpo) => Object.keys(corpo).length > 0, 'Mande ao menos um campo.');
const usoSchema = z.object({
  texto,
  salvar: z.boolean().optional(),
  tipos: z.array(z.enum(['troca', 'remocao'])).max(2).optional(),
});
const idSchema = z.object({ id: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/) });

export function createMotivosDaSeparacaoRoutes({ motivosDaSeparacao, requirePermission, accountForRequest }) {
  const router = Router();

  // A conta, o computador (X-Sessao) e a origem da tela (X-Origem) de quem agiu, para o Log da equipe.
  const contexto = async (request) => {
    const conta = await accountForRequest(request);
    const lojaId = conta.establishmentId;
    const computador = await nomeDoComputadorNaLoja(motivosDaSeparacao.firestore, lojaId, request.headers['x-sessao']);
    const origemDaAcao = origemDoCabecalho(String(request.headers['x-origem'] || ''), { porAdmin: conta.porAdminDaPlataforma === true });
    return { lojaId, conta, computador, origemDaAcao };
  };

  router.get('/', requirePermission('requests.view'), asyncHandler(async (request, response) => {
    const { tipo } = tipoSchema.parse(request.query ?? {});
    const { establishmentId } = await accountForRequest(request);
    response.json({ data: { motivos: await motivosDaSeparacao.listar({ lojaId: establishmentId, tipo: tipo || 'todos' }) } });
  }));

  router.post('/uso', requirePermission('requests.update_status'), asyncHandler(async (request, response) => {
    const corpo = usoSchema.parse(request.body);
    const resultado = await motivosDaSeparacao.usar({ ...(await contexto(request)), texto: corpo.texto, salvar: corpo.salvar === true, tipos: corpo.tipos || [] });
    response.json({ data: resultado });
  }));

  router.post('/', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const corpo = criarSchema.parse(request.body);
    const motivo = await motivosDaSeparacao.criar({ ...(await contexto(request)), ...corpo, origem: 'web' });
    response.status(201).json({ data: { motivo } });
  }));

  router.patch('/:id', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const { id } = idSchema.parse(request.params);
    const campos = editarSchema.parse(request.body);
    const motivo = await motivosDaSeparacao.editar({ ...(await contexto(request)), id, campos });
    response.json({ data: { motivo } });
  }));

  router.delete('/:id', requirePermission('settings.edit'), asyncHandler(async (request, response) => {
    const { id } = idSchema.parse(request.params);
    response.json({ data: await motivosDaSeparacao.apagar({ ...(await contexto(request)), id }) });
  }));

  return router;
}
