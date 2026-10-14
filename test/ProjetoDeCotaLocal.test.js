import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { connect } from 'node:net';
import test from 'node:test';
import { AgenteComProjetoDeCota, opcoesDoApp } from '../src/infra/firebase/firebaseAdmin.js';

// F1 (14/10/2026): o projeto de cota so vai com GOOGLE_CLOUD_QUOTA_PROJECT, e so para *.googleapis.com.
test('sem a variavel nada muda; com ela o app ganha o agente com o projeto de cota', () => {
  assert.equal(opcoesDoApp({}), undefined);
  assert.equal(opcoesDoApp({ GOOGLE_CLOUD_QUOTA_PROJECT: '  ' }), undefined);
  const opcoes = opcoesDoApp({ GOOGLE_CLOUD_QUOTA_PROJECT: 'appmobileprod-19505' });
  assert.ok(opcoes.httpAgent instanceof AgenteComProjetoDeCota);
  assert.equal(opcoes.httpAgent.projetoDeCota, 'appmobileprod-19505');
});

test('o agente poe x-goog-user-project nas chamadas a googleapis.com e em nenhuma outra', async () => {
  const recebidos = [];
  const servidor = createServer((requisicao, resposta) => {
    recebidos.push({ host: requisicao.headers.host, cota: requisicao.headers['x-goog-user-project'] ?? null });
    resposta.end('ok');
  });
  await new Promise((pronto) => servidor.listen(0, '127.0.0.1', pronto));
  const porta = servidor.address().port;
  // Conexao local em texto puro no lugar do TLS: o servidor de teste ve os cabecalhos enviados.
  const agente = new AgenteComProjetoDeCota('appmobileprod-19505', { keepAlive: false });
  agente.createConnection = () => connect(porta, '127.0.0.1');
  const chamar = (host) => new Promise((pronto, falha) => {
    const requisicao = request({ host, path: '/v1/accounts:lookup', method: 'POST', agent: agente }, (resposta) => { resposta.resume(); resposta.on('end', pronto); });
    requisicao.on('error', falha);
    requisicao.end('{}');
  });
  try {
    await chamar('identitytoolkit.googleapis.com');
    await chamar('exemplo.com');
  } finally {
    servidor.close();
    agente.destroy();
  }
  assert.deepEqual(recebidos, [
    { host: 'identitytoolkit.googleapis.com', cota: 'appmobileprod-19505' },
    { host: 'exemplo.com', cota: null },
  ]);
});
