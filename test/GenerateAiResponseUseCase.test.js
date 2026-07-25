import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerateAiResponseUseCase } from '../src/application/ai/GenerateAiResponseUseCase.js';

function capturingGateway(output = {}) {
  return {
    input: null,
    async generate(input) {
      this.input = input;
      return output;
    },
  };
}

test('home_overview exige JSON estruturado e proibe metricas inventadas', async () => {
  const gateway = capturingGateway({ summary: 'ok' });
  const useCase = new GenerateAiResponseUseCase({ aiGateway: gateway });

  await useCase.execute({
    prompt: 'Analise a Home.',
    context: { todaySales: { total: 100 } },
    task: 'home_overview',
    responseFormat: 'json',
  });

  assert.match(gateway.input.systemInstruction, /Retorne somente JSON valido/);
  assert.match(gateway.input.systemInstruction, /Nao invente fontes externas/);
  assert.match(gateway.input.systemInstruction, /pedidos\|mensagens\|produtos/);
});

test('home_assistant limita a resposta aos dados recebidos', async () => {
  const gateway = capturingGateway('ok');
  const useCase = new GenerateAiResponseUseCase({ aiGateway: gateway });

  await useCase.execute({
    prompt: 'O que devo priorizar?',
    context: { unread: { orders: 2, messages: 1 } },
    metadata: {
      feature: 'home_ai_assistant',
      firebaseUid: 'uid-que-nao-deve-chegar-ao-modelo',
    },
    task: 'home_assistant',
    responseFormat: 'text',
  });

  assert.match(gateway.input.systemInstruction, /Use somente os dados presentes no contexto/);
  assert.match(gateway.input.systemInstruction, /Nao afirme que executou uma acao/);
  assert.match(gateway.input.systemInstruction, /assessor executivo experiente/);
  assert.match(gateway.input.systemInstruction, /apenas com a gestao e a operacao do seu supermercado/);
  assert.match(gateway.input.userPrompt, /"orders": 2/);
  assert.doesNotMatch(gateway.input.userPrompt, /uid-que-nao-deve-chegar-ao-modelo/);
});
