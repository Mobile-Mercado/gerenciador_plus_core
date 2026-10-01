// Espelho do catalogo: uma varredura de Products por noite, lida pelas tres rotinas
// das 3h no lugar de cada uma varrer a colecao por conta.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions e recebe as
// referencias por parametro, como os outros modulos desta pasta.
//
// O espelho guarda RESULTADO, nao campo cru: wordKeys e searchIndex nao entram, e no
// lugar deles vai o booleano buscaQuebrada, calculado pela mesma funcao que a rotina de
// imagens usa hoje (searchKeys.js). A regra continua morando la.
const { hasBrokenSearch } = require('./searchKeys');

const ESPELHO_VERSION = 1;
const ESPELHO_DOCUMENT = 'catalogoEspelho';
const BLOCOS_SUBCOLECAO = 'blocos';
// Mil produtos por bloco. Medido em 01/10/2026: com dois mil, o maior bloco da G&S deu
// 956 KB, a 4,5% do limite de 1 MB por documento do Firestore. Bloco que falha ao gravar
// derruba o indice e joga as tres rotinas no recuo sem ninguem perceber.
const TAMANHO_DO_BLOCO = 1000;
const PAGINA_DE_LEITURA = 1000;
const TIME_ZONE = 'America/Sao_Paulo';

// Campos lidos de Products para montar o espelho. wordKeys e searchIndex sao lidos e
// descartados: viram o booleano buscaQuebrada.
const CAMPOS_LIDOS = Object.freeze([
  'name',
  'images',
  'tags',
  'categoriesIds',
  'isActive',
  'currentPrice',
  'quantityInStock',
  'shelvesIds',
  'wordKeys',
  'searchIndex',
]);

const formatador = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

function diaDe(data) {
  const partes = {};
  formatador.formatToParts(data).forEach(({ type, value }) => { partes[type] = value; });
  return `${partes.year}-${partes.month}-${partes.day}`;
}

function paraData(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate();
  if (valor instanceof Date) return valor;
  const convertido = new Date(valor);
  return Number.isNaN(convertido.getTime()) ? null : convertido;
}

// Do documento de Products para a linha do espelho. Guarda so a primeira imagem, e so
// o fileUrl dela, que e o unico pedaco que a rotina de imagens olha.
function produtoDoEspelho(id, dados = {}) {
  const primeira = Array.isArray(dados.images) ? dados.images[0] : null;
  const fileUrl = typeof primeira?.fileUrl === 'string' ? primeira.fileUrl : null;
  return {
    id,
    name: dados.name ?? null,
    images: fileUrl ? [{ fileUrl }] : [],
    tags: Array.isArray(dados.tags) ? dados.tags : [],
    categoriesIds: Array.isArray(dados.categoriesIds) ? dados.categoriesIds : [],
    isActive: dados.isActive === true,
    currentPrice: typeof dados.currentPrice === 'number' ? dados.currentPrice : null,
    quantityInStock: typeof dados.quantityInStock === 'number' ? dados.quantityInStock : null,
    shelvesIds: Array.isArray(dados.shelvesIds) ? dados.shelvesIds : [],
    buscaQuebrada: hasBrokenSearch({
      name: dados.name,
      wordKeys: dados.wordKeys,
      searchIndex: dados.searchIndex,
    }),
  };
}

function espelhoReference(storeRef) {
  return storeRef.collection('Stats').doc(ESPELHO_DOCUMENT);
}

function blocoReference(storeRef, numero) {
  return espelhoReference(storeRef).collection(BLOCOS_SUBCOLECAO).doc(String(numero));
}

function emBlocos(produtos, tamanho) {
  const blocos = [];
  for (let inicio = 0; inicio < produtos.length; inicio += tamanho) {
    blocos.push(produtos.slice(inicio, inicio + tamanho));
  }
  return blocos.length ? blocos : [[]];
}

async function lerProdutosDaColecao({ storeRef, documentIdPath = null, pagina = PAGINA_DE_LEITURA }) {
  const base = storeRef.collection('Products').where('isTrashed', '==', false);
  if (!documentIdPath) {
    const snapshot = await base.select(...CAMPOS_LIDOS).get();
    return snapshot.docs.map((documento) => produtoDoEspelho(documento.id, documento.data()));
  }

  const produtos = [];
  let ultimo = null;
  while (true) {
    let consulta = base.orderBy(documentIdPath).select(...CAMPOS_LIDOS).limit(pagina);
    if (ultimo) consulta = consulta.startAfter(ultimo);
    const snapshot = await consulta.get();
    if (snapshot.empty) break;
    snapshot.docs.forEach((documento) => {
      produtos.push(produtoDoEspelho(documento.id, documento.data()));
    });
    ultimo = snapshot.docs.at(-1);
    if (snapshot.size < pagina) break;
  }
  return produtos;
}

// Varre Products, grava os blocos e, por ultimo, o indice. O indice e o ultimo de
// proposito: se a passada morrer no meio, o indice antigo continua la, com geradoEm de
// ontem, e as tres rotinas caem no recuo em vez de ler bloco pela metade.
async function gerarEspelho({
  storeRef,
  documentIdPath = null,
  geradoEm,
  tamanhoDoBloco = TAMANHO_DO_BLOCO,
  pagina = PAGINA_DE_LEITURA,
}) {
  const produtos = await lerProdutosDaColecao({ storeRef, documentIdPath, pagina });
  const blocos = emBlocos(produtos, tamanhoDoBloco);

  for (let numero = 0; numero < blocos.length; numero += 1) {
    await blocoReference(storeRef, numero).set({ bloco: numero, produtos: blocos[numero] });
  }

  const indice = espelhoReference(storeRef);
  // Quantos blocos a passada anterior deixou, lido ANTES de sobrescrever o indice.
  const anterior = await indice.get();
  const blocosAntes = Number(anterior.exists ? anterior.get('blocos') : 0) || 0;
  await indice.set({
    version: ESPELHO_VERSION,
    geradoEm,
    total: produtos.length,
    blocos: blocos.length,
    tamanhoDoBloco,
  });

  // Passada anterior maior deixa bloco sobrando: ele sai, senao a contagem nunca bate.
  let removidos = 0;
  for (let numero = blocos.length; numero < blocosAntes; numero += 1) {
    await blocoReference(storeRef, numero).delete();
    removidos += 1;
  }

  return {
    total: produtos.length, blocos: blocos.length, blocosRemovidos: removidos,
  };
}

// Recuo obrigatorio: devolve { produtos } so quando o espelho esta inteiro e e de hoje.
// Em qualquer outro caso devolve { motivo }, e quem chamou le Products direto.
async function lerEspelho({ storeRef, agora = new Date() }) {
  const indice = await espelhoReference(storeRef).get();
  if (!indice.exists) return { motivo: 'sem-indice' };

  const geradoEm = paraData(indice.get('geradoEm'));
  if (!geradoEm) return { motivo: 'sem-data' };
  if (diaDe(geradoEm) !== diaDe(agora)) return { motivo: 'espelho-de-outro-dia' };

  const esperados = Number(indice.get('blocos')) || 0;
  const snapshot = await espelhoReference(storeRef).collection(BLOCOS_SUBCOLECAO).get();
  if (snapshot.size !== esperados) return { motivo: 'blocos-nao-batem' };

  const produtos = [];
  snapshot.docs
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .forEach((bloco) => {
      const lista = bloco.get('produtos');
      if (Array.isArray(lista)) produtos.push(...lista);
    });

  const total = Number(indice.get('total'));
  if (Number.isFinite(total) && produtos.length !== total) return { motivo: 'total-nao-bate' };

  return { produtos, total: produtos.length, blocos: snapshot.size };
}

// Usado pelas tres rotinas: devolve os produtos do espelho ou null, mais a origem para
// o relatorio da noite. Sem o registro da origem ninguem fica sabendo que o espelho
// parou de funcionar.
async function produtosDoEspelho({ storeRef, agora = new Date() }) {
  const resultado = await lerEspelho({ storeRef, agora });
  if (resultado.produtos) {
    return { produtos: resultado.produtos, origemDosProdutos: 'espelho' };
  }
  return { produtos: null, origemDosProdutos: `recuo:${resultado.motivo}` };
}

module.exports = {
  BLOCOS_SUBCOLECAO,
  CAMPOS_LIDOS,
  ESPELHO_DOCUMENT,
  ESPELHO_VERSION,
  TAMANHO_DO_BLOCO,
  blocoReference,
  diaDe,
  emBlocos,
  espelhoReference,
  gerarEspelho,
  lerEspelho,
  lerProdutosDaColecao,
  produtoDoEspelho,
  produtosDoEspelho,
};
