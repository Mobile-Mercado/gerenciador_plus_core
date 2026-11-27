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

test('o gateway devolve os tokens da chamada', async () => {
  const client = {
    responses: {
      create: async () => ({ output_text: 'ok', usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } }),
    },
  };
  const gateway = new OpenAiResponsesGateway({
    apiKey: 'teste', model: 'gpt-4.1-mini', temperature: 0.2, client,
  });
  const result = await gateway.generate({ systemInstruction: 'x', userPrompt: 'y', responseFormat: 'text' });
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 30, totalTokens: 150 });
});

// Criador de icones com IA no Admin (Thay, 27/11). A reducao para WEBP (sharp) entra simulada.
import { IconesComIa, MODELO_DE_ICONE, pedidoDoIcone } from '../src/application/admin/IconesComIa.js';
import { custoDeImagemUsd } from '../src/domain/ai/precosIa.js';

test('icone com IA: pedido, chamada ao GPT Image 2.5 flare, custo pelo uso e o arquivo so devolvido', async () => {
  assert.match(pedidoDoIcone({ categoria: 'Biscoitos', estilo: 'linha' }), /"Biscoitos".*Sem texto.*linha fina/s);
  assert.match(pedidoDoIcone({ categoria: 'Biscoitos', comReferencia: true }), /mesmo estilo/);
  const uso = { input_tokens: 100, input_tokens_details: { text_tokens: 100, image_tokens: 0 }, output_tokens: 1000 };
  assert.equal(custoDeImagemUsd(MODELO_DE_ICONE, uso), 0.0305);
  assert.equal(custoDeImagemUsd('outro', uso), null);
  const chamadas = [];
  const fetcher = async (url, opcoes) => {
    chamadas.push({ url, corpo: JSON.parse(opcoes.body) });
    return { ok: true, json: async () => ({ data: [{ b64_json: Buffer.from('png').toString('base64') }], usage: uso }) };
  };
  const registros = [];
  const ia = new IconesComIa({ apiKey: 'k', fetcher, reduzir: async () => Buffer.from('webp'), usoIaAdmin: { registrar: async (r) => registros.push(r) } });
  const resultado = await ia.gerar({ categoriaId: 'biscoitos', categoria: 'Biscoitos', qualidade: 'low', transparente: true });
  assert.equal(chamadas[0].url, 'https://api.openai.com/v1/images/generations');
  assert.deepEqual([chamadas[0].corpo.model, chamadas[0].corpo.quality, chamadas[0].corpo.background, chamadas[0].corpo.size], [MODELO_DE_ICONE, 'low', 'transparent', '1024x1024']);
  assert.deepEqual([resultado.tipoArquivo, resultado.custoUsd, resultado.conteudoBase64], ['image/webp', 0.0305, Buffer.from('webp').toString('base64')]);
  assert.equal(registros[0].custoUsd, 0.0305);
  await assert.rejects(new IconesComIa({ apiKey: '' }).gerar({ categoria: 'X' }), /chave da OpenAI/);
  const falha = new IconesComIa({ apiKey: 'k', fetcher: async () => ({ ok: false, json: async () => ({ error: { message: 'quota' } }) }) });
  await assert.rejects(falha.gerar({ categoria: 'X' }), /não gerou o ícone \(quota\)/);
});
