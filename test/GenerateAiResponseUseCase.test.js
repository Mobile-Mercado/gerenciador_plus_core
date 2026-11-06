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

test('registra o uso da IA na loja da sessao, sem segurar a resposta', async () => {
  const registros = [];
  const gateway = capturingGateway({
    provider: 'openai', model: 'gpt-4o', output: 'ok', usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
  });
  const useCase = new GenerateAiResponseUseCase({
    aiGateway: gateway,
    usoIaRepository: { registrar: async (lojaId, registro) => registros.push({ lojaId, registro }) },
  });

  const result = await useCase.execute({
    prompt: 'Sugira prateleiras.',
    task: 'categorizador_sugestoes',
    establishmentId: 'loja-a',
    metadata: { tela: 'categorizador', produtos: 20, firebaseUid: 'uid-1' },
  });
  await new Promise((resolve) => { setImmediate(resolve); });

  assert.equal(result.output, 'ok');
  assert.equal(registros.length, 1);
  assert.equal(registros[0].lojaId, 'loja-a');
  assert.equal(registros[0].registro.tokensEntrada, 1000);
  assert.equal(registros[0].registro.tokensSaida, 500);
  assert.equal(registros[0].registro.custoEstimadoUsd, 0.0075);
  assert.equal(registros[0].registro.tela, 'categorizador');
  assert.equal(registros[0].registro.produtos, 20);
});

test('sem loja da sessao, o uso nao e gravado', async () => {
  const registros = [];
  const useCase = new GenerateAiResponseUseCase({
    aiGateway: capturingGateway({ model: 'gpt-4o', output: 'ok' }),
    usoIaRepository: { registrar: async (...args) => registros.push(args) },
  });
  await useCase.execute({ prompt: 'Oi.' });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(registros.length, 0);
});

test('falha ao gravar o uso nao derruba a resposta', async () => {
  const erros = [];
  const useCase = new GenerateAiResponseUseCase({
    aiGateway: capturingGateway({ model: 'gpt-4o', output: 'ok' }),
    usoIaRepository: { registrar: async () => { throw new Error('sem rede'); } },
    logger: { error: (mensagem) => erros.push(mensagem) },
  });
  const result = await useCase.execute({ prompt: 'Oi.', establishmentId: 'loja-a' });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(result.output, 'ok');
  assert.deepEqual(erros, ['uso_ia_registro_falhou']);
});

test('C4: o assistente se apresenta como painel Móbile Gerenciador, sem "Plus"', async () => {
  const fs = await import('node:fs');
  const fonte = fs.readFileSync(new URL('../src/application/ai/GenerateAiResponseUseCase.js', import.meta.url), 'utf8');
  assert.ok(fonte.includes("'Voce e o assistente de IA do painel Móbile Gerenciador.'"));
  assert.equal(/gerenciador_plus|Gerenciador Plus/.test(fonte), false);
});
