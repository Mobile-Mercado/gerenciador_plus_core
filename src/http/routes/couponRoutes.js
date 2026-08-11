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
]);

const createCouponSchema = z.object({
  code: z.string().min(3).max(30),
  description: z.string().min(1).max(200),
  termsText: z.string().max(2000).optional(),
  firstPurchaseOnly: z.boolean().default(false),
  establishmentIds: z.array(z.string()).min(1),
  rules: z.array(ruleSchema).default([]),
  discount: z.object({
    kind: z.enum(['percentage', 'fixed']),
    value: z.number().positive(),
  }),
  startAt: z.string(),
  endAt: z.string(),
  perCustomerLimit: z.number().int().positive().default(1),
  totalUsageLimit: z.number().int().positive().nullable().default(null),
  stackable: z.boolean().default(false),
});

const couponIdParamsSchema = z.object({
  couponId: z.string().min(1),
});

export function createCouponRoutes({ manageCoupons, couponAdminMiddleware }) {
  const router = Router();
  router.use(couponAdminMiddleware);

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const result = await manageCoupons.listCoupons({ actorUid: request.auth.uid });
      response.json({ data: result });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (request, response) => {
      const payload = createCouponSchema.parse(request.body);
      const result = await manageCoupons.createCoupon({ actorUid: request.auth.uid, ...payload });
      response.status(201).json({ data: result });
    }),
  );

  router.post(
    '/:couponId/deactivate',
    asyncHandler(async (request, response) => {
      const { couponId } = couponIdParamsSchema.parse(request.params);
      await manageCoupons.deactivateCoupon({ actorUid: request.auth.uid, couponId });
      response.json({ data: { couponId, active: false } });
    }),
  );

  return router;
}
