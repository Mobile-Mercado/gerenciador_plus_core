// Lista de clientes de cada loja, em estabelecimentos/{loja}/Stats/clientesDaLoja.
//
// Existe para a politica de acesso parar de varrer PurchaseRequests a cada cinco minutos
// so para saber quem e cliente da loja.
//
// REGRA QUE MUDA O DESENHO: quem e cliente e cliente para sempre. A lista so CRESCE.
// Nunca e refeita por subtracao, e nunca e palavra final para negar: id que nao esta nela
// e verificado na hora e acrescentado, nao recusado. Por isso nao ha recuo por data aqui,
// ao contrario do espelho do catalogo: lista velha continua valida, so fica incompleta.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions. Recebe db, storeRef e,
// para acrescentar id, a funcao arrayUnion de quem chamou.
const CLIENTES_VERSION = 1;
const CLIENTES_DOCUMENT = 'clientesDaLoja';
const BLOCOS_SUBCOLECAO = 'blocos';
// Medido em 01/10/2026: 5.000 ids dao 103 KB, bem abaixo do teto de 1 MB por documento.
const TAMANHO_DO_BLOCO = 5000;

const CAMPOS_DE_CLIENTE = Object.freeze([
  'clientId',
  'customerId',
  'userId',
  'clientReference',
  'customerReference',
  'userReference',
]);

function idDeReferencia(valor) {
  if (!valor) return '';
  if (typeof valor === 'string') return valor.split('/').filter(Boolean).at(-1) || valor;
  if (valor.id) return String(valor.id);
  if (valor.path) return String(valor.path).split('/').filter(Boolean).at(-1) || '';
  return '';
}

// Mesma regra do clientIdFromOrder da politica: o primeiro campo preenchido vale.
function clienteDoPedido(pedido = {}) {
  return idDeReferencia(
    pedido.clientId
      || pedido.customerId
      || pedido.userId
      || pedido.clientReference
      || pedido.customerReference
      || pedido.userReference
      || pedido.client?.id
      || pedido.customer?.id
      || pedido.user?.id,
  );
}

function listaReference(storeRef) {
  return storeRef.collection('Stats').doc(CLIENTES_DOCUMENT);
}

function blocoReference(storeRef, numero) {
  return listaReference(storeRef).collection(BLOCOS_SUBCOLECAO).doc(String(numero));
}

function emBlocos(ids, tamanho) {
  const blocos = [];
  for (let inicio = 0; inicio < ids.length; inicio += tamanho) {
    blocos.push(ids.slice(inicio, inicio + tamanho));
  }
  return blocos.length ? blocos : [[]];
}

// Varre os pedidos da loja uma vez e devolve os ids de cliente.
async function clientesDosPedidos({ db, storeRef }) {
  const snapshot = await db
    .collection('PurchaseRequests')
    .where('companyReference', '==', storeRef)
    .select(...CAMPOS_DE_CLIENTE)
    .get();
  const ids = new Set();
  snapshot.docs.forEach((documento) => {
    const id = clienteDoPedido(documento.data());
    if (id) ids.add(id);
  });
  return { ids, pedidosLidos: snapshot.size };
}

// Blocos primeiro, indice por ultimo: passada morta no meio deixa o indice antigo, que
// aponta para blocos que existem.
async function gerarListaDeClientes({
  db, storeRef, geradoEm, tamanhoDoBloco = TAMANHO_DO_BLOCO,
}) {
  const { ids: dosPedidos, pedidosLidos } = await clientesDosPedidos({ db, storeRef });
  const anterior = await lerListaDeClientes({ storeRef });
  const anteriores = anterior.ids || [];

  // Uniao: nenhum id sai, nem quando o pedido dele desaparece.
  const todos = [...new Set([...anteriores, ...dosPedidos])].sort();
  const blocos = emBlocos(todos, tamanhoDoBloco);

  for (let numero = 0; numero < blocos.length; numero += 1) {
    await blocoReference(storeRef, numero).set({ bloco: numero, ids: blocos[numero] });
  }

  const indice = listaReference(storeRef);
  const indiceAntes = await indice.get();
  const blocosAntes = Number(indiceAntes.exists ? indiceAntes.get('blocos') : 0) || 0;
  await indice.set({
    version: CLIENTES_VERSION,
    geradoEm,
    total: todos.length,
    blocos: blocos.length,
    tamanhoDoBloco,
  });

  let removidos = 0;
  for (let numero = blocos.length; numero < blocosAntes; numero += 1) {
    await blocoReference(storeRef, numero).delete();
    removidos += 1;
  }

  return {
    total: todos.length,
    novos: todos.length - anteriores.length,
    blocos: blocos.length,
    blocosRemovidos: removidos,
    pedidosLidos,
  };
}

// Sem recuo por data: a lista so cresce. As unicas recusas sao indice ausente e numero de
// blocos diferente do indice.
async function lerListaDeClientes({ storeRef }) {
  const indice = await listaReference(storeRef).get();
  if (!indice.exists) return { motivo: 'sem-indice' };

  const esperados = Number(indice.get('blocos')) || 0;
  const snapshot = await listaReference(storeRef).collection(BLOCOS_SUBCOLECAO).get();
  if (snapshot.size !== esperados) return { motivo: 'blocos-nao-batem' };

  const ids = [];
  snapshot.docs
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .forEach((bloco) => {
      const lista = bloco.get('ids');
      if (Array.isArray(lista)) ids.push(...lista);
    });

  return {
    ids,
    total: ids.length,
    blocos: snapshot.size,
    geradoEm: indice.get('geradoEm') || null,
  };
}

// Acrescenta ids ao ultimo bloco, por arrayUnion, sem reescrever a lista inteira. Usado
// pela verificacao pontual da politica. arrayUnion vem de quem chamou, porque este arquivo
// nao importa SDK.
async function acrescentarClientes({
  storeRef, ids = [], arrayUnion, tamanhoDoBloco = TAMANHO_DO_BLOCO,
}) {
  const novos = [...new Set(ids.filter(Boolean))];
  if (!novos.length || typeof arrayUnion !== 'function') return { acrescentados: 0 };

  const indice = await listaReference(storeRef).get();
  if (!indice.exists) return { acrescentados: 0, motivo: 'sem-indice' };

  const blocos = Number(indice.get('blocos')) || 1;
  const ultimo = blocos - 1;
  await blocoReference(storeRef, ultimo).set(
    { bloco: ultimo, ids: arrayUnion(novos) },
    { merge: true },
  );
  await listaReference(storeRef).set(
    { total: (Number(indice.get('total')) || 0) + novos.length },
    { merge: true },
  );
  return { acrescentados: novos.length, bloco: ultimo, tamanhoDoBloco };
}

module.exports = {
  BLOCOS_SUBCOLECAO,
  CAMPOS_DE_CLIENTE,
  CLIENTES_DOCUMENT,
  CLIENTES_VERSION,
  TAMANHO_DO_BLOCO,
  acrescentarClientes,
  blocoReference,
  clienteDoPedido,
  clientesDosPedidos,
  emBlocos,
  gerarListaDeClientes,
  lerListaDeClientes,
  listaReference,
};
