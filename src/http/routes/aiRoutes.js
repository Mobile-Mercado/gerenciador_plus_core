import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middlewares/asyncHandler.js';

const aiRequestSchema = z.object({
  prompt: z.string().min(1).max(12000),
  task: z.string().min(1).max(80).optional(),
  responseFormat: z.enum(['text', 'json']).optional(),
  context: z.unknown().optional(),
  content: z.array(z.unknown()).optional(),
  model: z.string().min(1).max(80).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(1).max(16000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const insightsRequestSchema = z.object({
  question: z.string().min(1).max(12000),
  data: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const homeOverviewRequestSchema = z.object({
  establishmentId: z.string().min(1).max(160),
  context: z.unknown(),
});

export function createAiRoutes({ generateAiResponseUseCase, getDailyHomeOverviewUseCase }) {
  const router = Router();

  router.post(
    '/home-overview',
    asyncHandler(async (request, response) => {
      const input = homeOverviewRequestSchema.parse(request.body);
      const result = await getDailyHomeOverviewUseCase.execute({
        ...input,
        uid: request.auth?.uid,
      });

      response.json({ data: result });
    }),
  );

  router.post(
    '/responder',
    asyncHandler(async (request, response) => {
      const input = aiRequestSchema.parse(request.body);
      const result = await generateAiResponseUseCase.execute({
        ...input,
        task: input.task || 'responder',
        responseFormat: input.responseFormat || 'text',
        content: input.content,
        model: input.model,
        temperature: input.temperature,
        maxOutputTokens: input.maxOutputTokens,
        metadata: {
          ...input.metadata,
          firebaseUid: request.auth?.uid,
        },
      });

      response.json({ data: result });
    }),
  );

  router.post(
    '/insights',
    asyncHandler(async (request, response) => {
      const input = insightsRequestSchema.parse(request.body);
      const result = await generateAiResponseUseCase.execute({
        prompt: input.question,
        context: input.data,
        metadata: {
          ...input.metadata,
          firebaseUid: request.auth?.uid,
        },
        task: 'gerar_insights',
        responseFormat: 'json',
      });

      response.json({ data: result });
    }),
  );

  return router;
}
