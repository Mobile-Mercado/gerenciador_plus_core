import assert from 'node:assert/strict';
import test from 'node:test';
import { SugestoesDosClientes } from '../src/application/admin/SugestoesDosClientes.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

function banco(quantidade = 35) {
  const dados = {
    'estabelecimentos/loja-a': { name: 'Loja A' },
    'estabelecimentos/loja-b': { fantasyName: 'Loja B' },
  };
  for (let i = 0; i < quantidade; i += 1) {
    const loja = i % 2 ? 'loja-b' : 'loja-a';
    dados[`estabelecimentos/${loja}/Suggestions/s${String(i).padStart(2, '0')}`] = {
      text: i === 7 ? 'Falta pão de queijo congelado' : `Sugestão ${i}`,
      subject: 'products',
      userName: `Cliente ${i}`,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
      read: i % 3 === 0,
    };
  }
  return new FirestoreEmMemoria(dados);
}

test('todas as lojas, mais nova primeiro, em paginas de 30 com cursor', async () => {
  const firestore = banco();
  const sugestoes = new SugestoesDosClientes({ firestore });
  const primeira = await sugestoes.listar();
  assert.equal(primeira.itens.length, 30);
  assert.equal(primeira.itens[0].id, 's34');
  assert.equal(primeira.itens[0].nomeLoja, 'Loja A');
  assert.equal(primeira.itens[1].nomeLoja, 'Loja B');
  assert.ok(primeira.proximo);
  const segunda = await sugestoes.listar({ cursor: primeira.proximo });
  assert.deepEqual(segunda.itens.map((item) => item.id), ['s04', 's03', 's02', 's01', 's00']);
  assert.equal(segunda.proximo, null);
});

test('filtro por loja le so a colecao daquela loja', async () => {
  const sugestoes = new SugestoesDosClientes({ firestore: banco(10) });
  const resultado = await sugestoes.listar({ lojaId: 'loja-b' });
  assert.equal(resultado.itens.length, 5);
  assert.ok(resultado.itens.every((item) => item.lojaId === 'loja-b'));
});

test('busca no texto ignora acento e caixa', async () => {
  const sugestoes = new SugestoesDosClientes({ firestore: banco() });
  const resultado = await sugestoes.listar({ busca: 'PAO DE QUEIJO' });
  assert.deepEqual(resultado.itens.map((item) => item.id), ['s07']);
  assert.equal(resultado.itens[0].texto, 'Falta pão de queijo congelado');
});

test('o Admin so le: nada muda lida ou nao lida na loja', async () => {
  const firestore = banco();
  const sugestoes = new SugestoesDosClientes({ firestore });
  const resultado = await sugestoes.listar();
  await sugestoes.listar({ cursor: resultado.proximo, busca: 'sugestao' });
  assert.equal(firestore.escritas.length, 0);
  assert.equal(resultado.itens.find((item) => item.id === 's33').lida, true);
});

test('sem o indice de grupo, avisa e sugere filtrar por loja', async () => {
  const firestore = banco(3);
  const original = firestore.collectionGroup.bind(firestore);
  firestore.collectionGroup = (id) => {
    const consulta = original(id);
    consulta.get = async () => { throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires a COLLECTION_GROUP_DESC index'), { code: 9 }); };
    const ordenar = consulta.orderBy.bind(consulta);
    consulta.orderBy = (...args) => { const q = ordenar(...args); q.limit = () => q; q.get = consulta.get; return q; };
    return consulta;
  };
  await assert.rejects(new SugestoesDosClientes({ firestore }).listar(), (error) => error.statusCode === 503 && error.code === 'sugestoes_indice_pendente');
});
