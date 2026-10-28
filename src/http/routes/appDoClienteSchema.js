import { z } from 'zod';
import {
  BLOCOS_DA_HOME, COBRADO_EM, FORMAS_DE_PAGAMENTO, FUNCOES_DO_APP, PREPOSICOES_DA_BUSCA,
} from '../../domain/loja/appDoCliente.js';

// Contrato da versao 55 (cola RP-13): o que o Admin e a loja gravam para o app do cliente. Os
// limites vem de domain/loja/appDoCliente.js.

// Itens 5 e 6, so pelo Admin: interruptores sempre booleanos e os blocos da Home.
export const appDoClienteSchema = z.object({
  featureFlags: z.object(Object.fromEntries(Object.keys(FUNCOES_DO_APP).map((chave) => [chave, z.boolean().optional()]))).strict().optional(),
  aparenciaHome: z.object({
    ...Object.fromEntries(Object.entries(BLOCOS_DA_HOME).map(([bloco, { maximo }]) => [bloco, z.number().int().min(1).max(maximo).optional()])),
    preposicaoBusca: z.enum(PREPOSICOES_DA_BUSCA).optional(),
  }).strict().optional(),
}).strict();

// Pela propria loja (cola RP-58, item 2.1): so featureFlags.cuponsFiscais, sempre booleano.
export const cuponsFiscaisDaLojaSchema = z.object({
  featureFlags: z.object({ cuponsFiscais: z.boolean() }).strict(),
}).strict();

// Item 2: formas de pagamento, cada uma com ativa e onde e cobrada.
const formaSchema = z.object({ ativa: z.boolean().optional(), cobradoEm: z.enum(COBRADO_EM).optional() }).strict();
export const formasDePagamentoSchema = z.object({
  formas: z.object(Object.fromEntries(Object.keys(FORMAS_DE_PAGAMENTO).map((forma) => [forma, formaSchema.optional()]))).strict(),
}).strict();
