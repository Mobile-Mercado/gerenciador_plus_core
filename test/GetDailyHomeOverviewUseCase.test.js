import assert from 'node:assert/strict';
import test from 'node:test';
import { GetDailyHomeOverviewUseCase } from '../src/application/ai/GetDailyHomeOverviewUseCase.js';

function memoryInsightRepository() {
  const records = new Map();
  const key = ({ establishmentId, dateKey }) => `${establishmentId}:${dateKey}`;

  return {
    async get(input) {
      return records.get(key(input)) || null;
    },
    async tryAcquire(input) {
      const recordKey = key(input);
      const record = records.get(recordKey);
      if (record?.status === 'ready' || record?.status === 'generating') return false;
      records.set(recordKey, { status: 'generating' });
      return true;
    },
    async save(input) {
      records.set(key(input), {
        status: 'ready',
        output: input.output,
        provider: input.provider,
        model: input.model,
      });
    },
    async markFailed(input) {
      records.set(key(input), { status: 'failed' });
    },
  };
}

test('gera o insight apenas uma vez por loja no mesmo dia', async () => {
  let generations = 0;
  const useCase = new GetDailyHomeOverviewUseCase({
    accessRepository: {
      userCanAccess: async () => true,
    },
    insightRepository: memoryInsightRepository(),
    generateAiResponseUseCase: {
      execute: async () => {
        generations += 1;
        return {
          provider: 'groq',
          model: 'qwen/qwen3.6-27b',
          responseFormat: 'json',
          output: {
            summary: 'Resumo do dia.',
            insight: { message: 'Insight do dia.' },
          },
        };
      },
    },
    now: () => new Date('2026-07-25T12:00:00.000Z'),
  });

  const input = {
    uid: 'uid-lojista',
    establishmentId: 'loja-1',
    context: { todaySales: { total: 100 } },
  };
  const first = await useCase.execute(input);
  const second = await useCase.execute({
    ...input,
    context: { todaySales: { total: 999 } },
  });

  assert.equal(generations, 1);
  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.deepEqual(second.output, first.output);
});

test('mantem o cache diario isolado por estabelecimento', async () => {
  let generations = 0;
  const useCase = new GetDailyHomeOverviewUseCase({
    accessRepository: {
      userCanAccess: async () => true,
    },
    insightRepository: memoryInsightRepository(),
    generateAiResponseUseCase: {
      execute: async () => {
        generations += 1;
        return {
          provider: 'openai',
          model: 'gpt-4.1-mini',
          responseFormat: 'json',
          output: {
            summary: `Resumo ${generations}`,
            insight: { message: `Insight ${generations}` },
          },
        };
      },
    },
    now: () => new Date('2026-07-25T12:00:00.000Z'),
  });

  await useCase.execute({ uid: 'uid-1', establishmentId: 'loja-1', context: {} });
  await useCase.execute({ uid: 'uid-2', establishmentId: 'loja-2', context: {} });

  assert.equal(generations, 2);
});

test('nega o resumo quando o usuario nao pertence ao estabelecimento', async () => {
  const useCase = new GetDailyHomeOverviewUseCase({
    accessRepository: {
      userCanAccess: async () => false,
    },
    insightRepository: memoryInsightRepository(),
    generateAiResponseUseCase: {
      execute: async () => {
        throw new Error('nao deveria gerar');
      },
    },
  });

  await assert.rejects(
    () => useCase.execute({ uid: 'uid-1', establishmentId: 'loja-2', context: {} }),
    (error) => error.code === 'establishment_access_denied' && error.statusCode === 403,
  );
});
