import assert from 'node:assert/strict';
import test from 'node:test';
import { EntregadoresDaLoja } from '../src/application/loja/EntregadoresDaLoja.js';
import { ManagerDataAccessPolicy } from '../src/infra/firebase/ManagerDataAccessPolicy.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

let horas = 0;
function montar(dados = {}) {
  const banco = new FirestoreEmMemoria({ 'estabelecimentos/loja-1': { name: 'Loja', deliveryMenList: [] }, ...dados });
  horas = 0;
  const entregadores = new EntregadoresDaLoja({ firestore: banco, serverTimestamp: () => new Date(Date.UTC(2026, 9, 17, 12 + (horas += 1))) });
  return { banco, entregadores };
}

const privados = (banco) => [...banco.docs.entries()]
  .filter(([caminho]) => caminho.startsWith('estabelecimentos/loja-1/entregadoresPrivado/'))
  .map(([caminho, dados]) => ({ id: caminho.split('/').at(-1), ...dados }));

test('PUT grava a lista inteira: celular na subcolecao privada e deliveryMenList so com os nomes', async () => {
  const { banco, entregadores } = montar();
  const lista = await entregadores.salvar('loja-1', [
    { name: ' Carlos  Souza ', phone: '(27) 99876-5432' },
    { name: 'Bia', phone: '' },
  ]);
  assert.deepEqual(lista.map(({ name, phone }) => ({ name, phone })), [
    { name: 'Bia', phone: null },
    { name: 'Carlos Souza', phone: '27998765432' },
  ]);
  assert.ok(lista.every((item) => item.id));
  assert.deepEqual(banco.dados('estabelecimentos/loja-1').deliveryMenList, ['Carlos Souza', 'Bia']);
  assert.equal(JSON.stringify(banco.dados('estabelecimentos/loja-1')).includes('27998765432'), false, 'o celular nao vai para a loja');
  const carlos = privados(banco).find((item) => item.name === 'Carlos Souza');
  assert.equal(carlos.phone, '27998765432');
  assert.ok(carlos.createdAt && carlos.updatedAt);
});

test('PUT de novo: quem ficou mantem o id e o createdAt, quem saiu e apagado, celular muda', async () => {
  const { banco, entregadores } = montar();
  await entregadores.salvar('loja-1', [{ name: 'Carlos', phone: '27998765432' }, { name: 'Bia' }]);
  const antes = privados(banco).find((item) => item.name === 'Carlos');
  await entregadores.salvar('loja-1', [{ name: 'carlos', phone: '27999990000' }, { name: 'Davi', phone: '11987654321' }]);
  const depois = privados(banco);
  assert.deepEqual(depois.map((item) => item.name).sort(), ['Davi', 'carlos']);
  const carlos = depois.find((item) => item.name === 'carlos');
  assert.equal(carlos.id, antes.id);
  assert.equal(carlos.createdAt.getTime(), antes.createdAt.getTime());
  assert.equal(carlos.phone, '27999990000');
  assert.deepEqual(banco.dados('estabelecimentos/loja-1').deliveryMenList, ['carlos', 'Davi']);
  await entregadores.salvar('loja-1', []);
  assert.equal(privados(banco).length, 0);
  assert.deepEqual(banco.dados('estabelecimentos/loja-1').deliveryMenList, []);
});

test('validacao: nome obrigatorio e sem repetir, celular com DDD (11 digitos)', async () => {
  const { banco, entregadores } = montar();
  const recusa = (lista, codigo) => assert.rejects(entregadores.salvar('loja-1', lista), (erro) => erro.code === codigo && erro.statusCode === 400);
  await recusa([{ name: 'A' }], 'entregador_nome_invalido');
  await recusa([{ name: 'Ana' }, { name: ' ana ' }], 'entregador_repetido');
  await recusa([{ name: 'Ana', phone: '2733334444' }], 'entregador_celular_invalido');
  await recusa([{ name: 'Ana', phone: '9987654321' }], 'entregador_celular_invalido');
  await recusa(Array.from({ length: 51 }, (_, i) => ({ name: `Pessoa ${i}` })), 'entregadores_lista_invalida');
  await assert.rejects(entregadores.salvar('nao-existe', []), (erro) => erro.code === 'loja_nao_encontrada');
  assert.equal(privados(banco).length, 0);
});

test('GET: [{ id, name, phone }] por nome; nome so da lista antiga entra com id e phone null', async () => {
  const { entregadores } = montar({ 'estabelecimentos/loja-1': { name: 'Loja', deliveryMenList: ['Zé', 'Ana'] } });
  assert.deepEqual(await entregadores.listar('loja-1'), [{ id: null, name: 'Ana', phone: null }, { id: null, name: 'Zé', phone: null }]);
  await entregadores.salvar('loja-1', [{ name: 'Ana', phone: '27998765432' }]);
  const lista = await entregadores.listar('loja-1');
  assert.equal(lista.length, 1);
  assert.equal(lista[0].phone, '27998765432');
});

test('BFF de dados nunca le nem grava entregadoresPrivado, nem na loja da propria conta', async () => {
  const policy = new ManagerDataAccessPolicy({ firestore: new FirestoreEmMemoria() });
  const actor = { uid: 'uid-1', userId: 'loja-1', establishmentId: 'loja-1', hasEstablishment: true };
  const negado = (erro) => erro.statusCode === 403;
  await assert.rejects(policy.assertRead({ actor, target: { kind: 'collection', path: 'estabelecimentos/loja-1/entregadoresPrivado' } }), negado);
  await assert.rejects(policy.assertRead({ actor, target: { kind: 'document', path: 'estabelecimentos/loja-1/entregadoresPrivado/x' } }), negado);
  await assert.rejects(policy.assertMutation({
    actor, mutation: { operation: 'set', target: { kind: 'document', path: 'estabelecimentos/loja-1/entregadoresPrivado/x' }, data: { phone: '1' } },
  }), negado);
  // O resto da loja continua como antes.
  await policy.assertRead({ actor, target: { kind: 'document', path: 'estabelecimentos/loja-1' } });
});

test('rotas GET e PUT /api/loja/entregadores: loja da conta, ver pedidos para ler e settings.edit para gravar', async () => {
  const { default: express } = await import('express');
  const { createEntregadoresDaLojaRoutes } = await import('../src/http/routes/entregadoresDaLojaRoutes.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { AppError } = await import('../src/domain/errors/AppError.js');
  const { banco, entregadores } = montar();
  const app = express();
  app.use(express.json());
  app.use('/api/loja/entregadores', createEntregadoresDaLojaRoutes({
    entregadoresDaLoja: entregadores,
    requirePermission: (chave) => (request, _response, next) => {
      const chaves = String(request.headers['x-chaves'] || '').split(',');
      next(chaves.includes(chave) ? undefined : new AppError('sem', { statusCode: 403, code: 'permission_denied', details: { key: chave } }));
    },
    accountForRequest: async () => ({ establishmentId: 'loja-1' }),
  }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/loja/entregadores`;
  const put = (chaves, corpo) => fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-chaves': chaves }, body: JSON.stringify(corpo) });
  try {
    assert.equal((await put('requests.view', [{ name: 'Ana' }])).status, 403);
    const gravado = await put('settings.edit', [{ name: 'Ana', phone: '27998765432' }]);
    assert.equal(gravado.status, 200);
    assert.equal((await gravado.json()).data[0].phone, '27998765432');
    assert.equal((await fetch(base, { headers: { 'x-chaves': 'settings.edit' } })).status, 403);
    const lido = await (await fetch(base, { headers: { 'x-chaves': 'requests.view' } })).json();
    assert.deepEqual(lido.data.map(({ name, phone }) => ({ name, phone })), [{ name: 'Ana', phone: '27998765432' }]);
    assert.equal((await put('settings.edit', { name: 'Ana' })).status, 400, 'a lista vai inteira');
    assert.deepEqual(banco.dados('estabelecimentos/loja-1').deliveryMenList, ['Ana']);
  } finally {
    servidor.close();
  }
});
