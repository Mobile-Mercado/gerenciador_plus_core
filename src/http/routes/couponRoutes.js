import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';

const ruleSchema = z.union([
  z.object({ type: z.literal('product'), productIds: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('category'), categoryIds: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('minValue'), minValue: z.number().positive() }),
  z.object({
    type: z.literal('freight'),
    freeShipping: z.boolean(),
    discount: z.object({
      kind: z.enum(['percentage', 'fixed']),
      value: z.number().positive(),
    }).optional(),
  }),
  z.object({
    type: z.literal('quantityRange'),
    minQuantity: z.number().int().positive(),
    maxQuantity: z.number().int().positive().nullable(),
  }),
  // "Leve N pague M" ou "leve N por R$ X" (F3, 14/10/2026): o cupom guarda so a regra; o desconto e
  // calculado em aplicarCupom com o preco do produto na hora. N inteiro maior que 1, M inteiro de 1 a
  // N - 1, X maior que zero, e so um dos dois (M ou X). repeat: a cada N.
  z.object({
    type: z.literal('bundle'),
    productId: z.string().min(1).max(200),
    quantity: z.number().int().min(2),
    payQuantity: z.number().int().min(1).nullable().default(null),
    bundlePrice: z.number().positive().nullable().default(null),
    repeat: z.boolean().default(false),
  }).refine((rule) => (rule.payQuantity === null) !== (rule.bundlePrice === null), {
    message: 'Informe "pague M" ou "por R$ X" (um dos dois).',
  }).refine((rule) => rule.payQuantity === null || rule.payQuantity < rule.quantity, {
    message: 'M precisa ser menor que N.',
  }),
]);

// Cupons completos (D6, 14/10/2026): frete gratis vai so com a regra freight (discount null), cupom
// sem data de fim vai com endAt null, cupom pessoal leva targetClientId (so esse cliente aplica) e o
// cupom de campanha leva campaignId.
const temFrete = (rules = []) => rules.some((rule) => rule.type === 'freight');
const temLeveN = (rules = []) => rules.some((rule) => rule.type === 'bundle');

const createCouponSchema = z.object({
  code: z.string().min(3).max(30),
  description: z.string().min(1).max(200),
  termsText: z.string().max(2000).optional(),
  scopeName: z.string().max(60).optional(),
  firstPurchaseOnly: z.boolean().default(false),
  rules: z.array(ruleSchema).default([]),
  discount: z.object({
    kind: z.enum(['percentage', 'fixed']),
    value: z.number().positive(),
  }).nullable().default(null),
  startAt: z.string(),
  endAt: z.string().nullable().default(null),
  perCustomerLimit: z.number().int().positive().default(1),
  totalUsageLimit: z.number().int().positive().nullable().default(null),
  stackable: z.boolean().default(false),
  // "Para todos" ou "Para um cliente" (versao 55): no pessoal, targetClientId e o id do Users do
  // cliente escolhido; o Core confere e grava o destinatario. Sem tipo, vale o de antes.
  tipo: z.enum(['todos', 'cliente']).nullable().default(null),
  targetClientId: z.string().min(1).max(128).nullable().default(null),
  campaignId: z.string().min(1).max(128).nullable().default(null),
}).refine(
  (coupon) => coupon.discount !== null || temFrete(coupon.rules) || temLeveN(coupon.rules),
  { message: 'Informe o desconto, a regra de frete ou o leve N.', path: ['discount'] },
);

const buscaClientesSchema = z.object({ busca: z.string().max(100).optional() });

const couponIdParamsSchema = z.object({
  couponId: z.string().min(1),
});

const updateCouponSchema = z.object({
  code: z.string().min(3).max(30).optional(),
  description: z.string().min(1).max(200).optional(),
  termsText: z.string().max(2000).optional(),
  scopeName: z.string().max(60).optional(),
  firstPurchaseOnly: z.boolean().optional(),
  rules: z.array(ruleSchema).optional(),
  discount: z.object({
    kind: z.enum(['percentage', 'fixed']),
    value: z.number().positive(),
  }).nullable().optional(),
  startAt: z.string().optional(),
  endAt: z.string().nullable().optional(),
  perCustomerLimit: z.number().int().positive().optional(),
  totalUsageLimit: z.number().int().positive().nullable().optional(),
  stackable: z.boolean().optional(),
}).refine(
  (patch) => Object.keys(patch).length > 0,
  { message: 'Envie ao menos um campo para atualizar.' },
);

// A loja vem da conta da requisicao (accountForRequest): dono, funcionario com adminOf e Admin da
// plataforma na loja escolhida (C5.2, 13/10/2026).
export function createCouponRoutes({ manageCoupons, requirePermission, accountForRequest }) {
  const router = Router();
  const lojaDaRequisicao = async (request) => (await accountForRequest(request)).establishmentId;

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const result = await manageCoupons.listCoupons({ actorUid: request.auth.uid, establishmentId: await lojaDaRequisicao(request) });
      response.json({ data: result });
    }),
  );

  // Clientes da loja para o cupom "Para um cliente" (cola RP-14 A.2), com a permissao de cupons.
  router.get(
    '/clientes',
    requirePermission('coupons.manage'),
    asyncHandler(async (request, response) => {
      const { busca } = buscaClientesSchema.parse(request.query);
      response.json({ data: await manageCoupons.buscarClientes({ actorUid: request.auth.uid, establishmentId: await lojaDaRequisicao(request), busca }) });
    }),
  );

  router.post(
    '/',
    requirePermission('coupons.manage'),
    asyncHandler(async (request, response) => {
      const payload = createCouponSchema.parse(request.body);
      const result = await manageCoupons.createCoupon({ actorUid: request.auth.uid, establishmentId: await lojaDaRequisicao(request), ...payload });
      response.status(201).json({ data: result });
    }),
  );

  router.patch(
    '/:couponId',
    requirePermission('coupons.manage'),
    asyncHandler(async (request, response) => {
      const { couponId } = couponIdParamsSchema.parse(request.params);
      const patch = updateCouponSchema.parse(request.body);
      await manageCoupons.updateCoupon({ actorUid: request.auth.uid, establishmentId: await lojaDaRequisicao(request), couponId, patch });
      response.json({ data: { couponId, ...patch } });
    }),
  );

  router.post(
    '/:couponId/deactivate',
    requirePermission('coupons.manage'),
    asyncHandler(async (request, response) => {
      const { couponId } = couponIdParamsSchema.parse(request.params);
      await manageCoupons.deactivateCoupon({ actorUid: request.auth.uid, establishmentId: await lojaDaRequisicao(request), couponId });
      response.json({ data: { couponId, active: false } });
    }),
  );

  router.delete(
    '/:couponId',
    requirePermission('coupons.manage'),
    asyncHandler(async (request, response) => {
      const { couponId } = couponIdParamsSchema.parse(request.params);
      await manageCoupons.deleteCoupon({ actorUid: request.auth.uid, establishmentId: await lojaDaRequisicao(request), couponId });
      response.json({ data: { couponId } });
    }),
  );

  return router;
}
