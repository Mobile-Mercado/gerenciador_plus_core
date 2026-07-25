import assert from 'node:assert/strict';
import test from 'node:test';
import { GroqResponsesGateway } from '../src/infra/groq/GroqResponsesGateway.js';
import { OpenAiResponsesGateway } from '../src/infra/openai/OpenAiResponsesGateway.js';

test('Groq usa o modelo configurado e ignora override de modelo OpenAI', async () => {
  const client = {
    request: null,
    responses: {
      create: async (request) => {
        client.request = request;
        return { output_text: '{"ok":true}' };
      },
    },
  };
  const gateway = new GroqResponsesGateway({
    apiKey: 'teste',
    model: 'qwen/qwen3.6-27b',
    temperature: 0.2,
    client,
  });

  const result = await gateway.generate({
    systemInstruction: 'Responda em JSON.',
    userPrompt: 'Analise.',
    responseFormat: 'json',
    model: 'gpt-4o-mini',
    content: [
      { type: 'input_text', text: 'Produto 1' },
      { type: 'input_image', image_url: 'https://example.com/produto.jpg' },
    ],
  });

  assert.equal(client.request.model, 'qwen/qwen3.6-27b');
  assert.equal(client.request.input[1].content[1].type, 'input_image');
  assert.equal(result.provider, 'groq');
  assert.deepEqual(result.output, { ok: true });
});

test('OpenAI preserva o override de modelo usado pela automacao', async () => {
  const client = {
    request: null,
    responses: {
      create: async (request) => {
        client.request = request;
        return { output_text: 'ok' };
      },
    },
  };
  const gateway = new OpenAiResponsesGateway({
    apiKey: 'teste',
    model: 'gpt-4.1-mini',
    temperature: 0.2,
    client,
  });

  const result = await gateway.generate({
    systemInstruction: 'Seja breve.',
    userPrompt: 'Responda.',
    responseFormat: 'text',
    model: 'gpt-4o',
  });

  assert.equal(client.request.model, 'gpt-4o');
  assert.equal(result.provider, 'openai');
});
