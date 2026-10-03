// Resumo de vendas de cada loja, em estabelecimentos/{loja}/ResumoVendas/{AAAA-MM}.
//
// Existe para a Home e o Financeiro pararem de baixar pedidos inteiros (86% do peso e o
// productsCart) so para somar vendas. Cada documento e um mes da data da venda e traz o
// que as telas somam: por dia, por hora, por dia da semana e hora (mapa de calor) e os
// rankings de produtos, categorias, clientes e bairros.
//
// UMA REGRA SO DE VENDA (decisao do Thay), copiada do useEarningsBridge.js do painel
// (web_gerenciador_plus/src/features/dashboard), com purchaseStatus.js e testOrders.js:
//   - conta o status confirmado: accepted, picking, separatingOrder, waitingForDelivery,
//     waiting, deliveryRoute, on_route, completed, delivered (sem caixa, sem prefixo);
//   - pedido de teste (isTest ou isTestAccount) fica fora;
//   - data da venda: paidAt, depois acceptedAt, depois createdAt, no fuso de Sao Paulo;
//   - valor da venda: price (itens, sem frete); frete e o deliveryPrice; total e o total do
//     pedido pela regra da tela Pedidos (resumoPedidos.js);
//   - canal agente ou app pela mesma regra de orderChannel.
// Os rankings copiam o useHomeRankingsBridge.js: chave e nome do produto, categorias do
// item ou do produto, chave do cliente e chave de bairro. Mudou a regra la, muda aqui.
//
// DIA: estabelecimentos/{loja}/ResumoVendasDia/{AAAA-MM-DD} traz so as vendas do dia por
// hora e canal (horas.{hHH}.{app|agent}.{price, pedidos}), para a Home somar as vendas de
// hoje sem ler o ResumoPedidos do mes. Grava na mesma transacao do mes, com o mesmo sinal.
//
// IDEMPOTENCIA: cada pedido guarda o que somou em ResumoVendasContribuicoes/{pedidoId}.
// Numa gravacao do pedido, o Core tira a contribuicao antiga e poe a nova com
// FieldValue.increment, numa transacao. Pedido que deixa de ser venda, vira teste, e
// apagado ou muda de loja sai do resumo. Entrada que zera continua no mapa com zero: quem
// le filtra por quantidade maior que zero.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions. Para gravar, recebe db e
// o FieldValue de quem chamou.
const { marcarMudanca } = require('./marcador');
const { getOrderTotal } = require('./resumoPedidos');

const RESUMO_VENDAS_VERSION = 1;
const RESUMO_VENDAS_COLLECTION = 'ResumoVendas';
const RESUMO_VENDAS_DIA_COLLECTION = 'ResumoVendasDia';
const CONTRIBUICOES_COLLECTION = 'ResumoVendasContribuicoes';
const TIME_ZONE = 'America/Sao_Paulo';

// ----- Copia de purchaseStatus.js e testOrders.js -----

const confirmedPurchaseStatuses = new Set([
  'accepted',
  'picking',
  'separatingorder',
  'waitingfordelivery',
  'waiting',
  'deliveryroute',
  'on_route',
  'completed',
  'delivered',
]);

function normalizePurchaseStatus(value) {
  return String(value || '')
    .replace(/^PurchaseStatus\./i, '')
    .trim()
    .toLowerCase();
}

function isConfirmedPurchaseStatus(value) {
  return confirmedPurchaseStatuses.has(normalizePurchaseStatus(value));
}

function isTestOrder(data) {
  return data?.isTest === true || data?.isTestAccount === true;
}

// ----- Copia de useEarningsBridge.js -----

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nestedValue(source, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], source);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function orderChannel(data) {
  if (data.agentOrder || data.isAgentOrder || data.createdByAgent || data.fromAgent) return 'agent';
  const source = String(
    nestedValue(data, ['channel', 'source', 'origin', 'platform', 'orderChannel', 'purchaseOrigin', 'createdBy']) || '',
  ).toLowerCase();
  return /(agent|agente|whatsapp|chat|ia)/.test(source) ? 'agent' : 'app';
}

// ----- Copia de useHomeRankingsBridge.js -----

function refId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.split('/').filter(Boolean).at(-1) || value;
  return value.id || value.path?.split('/').filter(Boolean).at(-1) || '';
}

function get(data, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((acc, key) => acc?.[key], data);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const cleaned = value.replace(/[^\d,.-]/g, '');
  const parsed = Number(cleaned.includes(',') ? cleaned.replaceAll('.', '').replace(',', '.') : cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function orderClientKey(data) {
  return refId(get(data, ['clientId', 'customerId', 'userId', 'clientReference', 'customerReference', 'client.id', 'customer.id']));
}

function orderClientName(data) {
  return get(data, ['clientName', 'customerName', 'client.name', 'customer.name']) || 'Cliente';
}

function orderNeighborhood(data) {
  const address = data.address || data.deliveryAddress || data.clientAddress;
  return get(address || {}, ['neighborhood', 'bairro']) || '';
}

function itemProductId(item) {
  return refId(get(item, ['productReference', 'productRef', 'reference', 'product.id', 'productData.id', 'productId', 'id']));
}

function itemProductName(item) {
  return get(item, ['product.name', 'productData.name', 'name']) || '';
}

function itemCategoryIds(item, productMeta) {
  const direct = get(item, ['categoriesIds', 'product.categoriesIds', 'productData.categoriesIds']);
  if (Array.isArray(direct) && direct.length) return direct;
  const shelves = get(item, ['shelves', 'product.shelves', 'productData.shelves']);
  if (Array.isArray(shelves) && shelves.length) {
    return shelves.map((shelf) => shelf.productCategoryId || shelf.categoryId).filter(Boolean);
  }
  if (Array.isArray(productMeta?.categoriesIds) && productMeta.categoriesIds.length) {
    return productMeta.categoriesIds;
  }
  if (Array.isArray(productMeta?.shelves) && productMeta.shelves.length) {
    return productMeta.shelves
      .map((shelf) => shelf.productCategoryId || shelf.categoryId)
      .filter(Boolean);
  }
  return [];
}

function norm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// Valor de um item, pela mesma conta do orderPrice do ranking quando o pedido nao tem
// price: total do item ou quantidade vezes preco.
function itemValue(item) {
  const itemTotal = get(item, ['total', 'totalPrice', 'subtotal', 'amount']);
  if (itemTotal !== null) return num(itemTotal);
  const price = get(item, ['price', 'currentPrice', 'unitPrice', 'product.price']);
  return (num(item.quantity) || 1) * num(price);
}

// Produto do item precisa do documento quando falta nome ou categoria, como no painel.
function itemPrecisaDoProduto(item) {
  const productId = itemProductId(item);
  if (!productId) return false;
  return !itemProductName(item) || !itemCategoryIds(item, null).map(refId).filter(Boolean).length;
}

// ----- Regra de venda -----

function ehVenda(data) {
  if (!data || isTestOrder(data)) return false;
  return isConfirmedPurchaseStatus(data.currentPurchaseStatus || data.purchaseStatus || data.status || data.stats);
}

function dataDaVenda(data) {
  return toDate(data.paidAt) || toDate(data.acceptedAt) || toDate(data.createdAt);
}

const formatadorDeData = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});
const DIAS_DA_SEMANA = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Mes, dia, hora e dia da semana da venda no fuso de Sao Paulo.
function momentoDaVenda(date) {
  const partes = {};
  formatadorDeData.formatToParts(date).forEach(({ type, value }) => { partes[type] = value; });
  const hora = String(Number(partes.hour) % 24).padStart(2, '0');
  return {
    mes: `${partes.year}-${partes.month}`,
    dia: partes.day,
    hora: `h${hora}`,
    semanaHora: `d${DIAS_DA_SEMANA.indexOf(partes.weekday)}h${hora}`,
  };
}

// O que um pedido soma no resumo, ou null quando nao e venda. `meta` traz os documentos
// de produto (Map id -> dados) e os nomes de categoria (Map id -> nome) que faltam no item.
function contribuicaoDoPedido(id, data, meta = {}) {
  if (!ehVenda(data)) return null;
  const vendidoEm = dataDaVenda(data);
  if (!vendidoEm) return null;
  const produtosMeta = meta.produtos || new Map();
  const nomesDeCategoria = meta.categorias || new Map();

  const produtos = {};
  const categorias = {};
  (data.productsCart || data.items || []).forEach((item) => {
    const quantity = num(item.quantity) || 1;
    const productId = itemProductId(item);
    const productName = itemProductName(item);
    const productKey = productId || (productName ? `name:${norm(productName)}` : '');
    if (!productKey) return;
    const valor = itemValue(item);
    const produto = produtos[productKey] || {
      nome: productName || produtosMeta.get(productId)?.name || 'Produto', qtd: 0, valor: 0,
    };
    produto.qtd += quantity;
    produto.valor += valor;
    produtos[productKey] = produto;
    const categoryIds = new Set(itemCategoryIds(item, produtosMeta.get(productId)).map(refId).filter(Boolean));
    categoryIds.forEach((categoryId) => {
      const categoria = categorias[categoryId] || { nome: nomesDeCategoria.get(categoryId) || 'Categoria', qtd: 0, valor: 0 };
      categoria.qtd += quantity;
      categoria.valor += valor;
      categorias[categoryId] = categoria;
    });
  });

  const neighborhood = orderNeighborhood(data);
  const price = toNumber(data.price);
  return {
    pedidoId: id,
    ...momentoDaVenda(vendidoEm),
    canal: orderChannel(data),
    price,
    frete: toNumber(data.deliveryPrice),
    total: getOrderTotal(data),
    produtos,
    categorias,
    cliente: { chave: orderClientKey(data) || norm(orderClientName(data)), nome: orderClientName(data), valor: price },
    bairro: neighborhood ? { chave: norm(neighborhood), nome: neighborhood } : null,
  };
}

// ----- Soma no documento do mes -----

// Acumula deltas numericos e nomes por caminho, para juntar tirar e por num objeto so.
function novoAcumulador() {
  return { deltas: new Map(), nomes: new Map() };
}

function somar(acumulador, caminho, valor) {
  if (!valor) return;
  const chave = JSON.stringify(caminho);
  acumulador.deltas.set(chave, (acumulador.deltas.get(chave) || 0) + valor);
}

function nomear(acumulador, caminho, nome) {
  acumulador.nomes.set(JSON.stringify(caminho), nome);
}

// Poe (sinal 1) ou tira (sinal -1) uma contribuicao no acumulador do mes dela.
function aplicar(acumulador, contribuicao, sinal) {
  const { dia, hora, semanaHora, canal } = contribuicao;
  const valores = { pedidos: 1, price: contribuicao.price, frete: contribuicao.frete, total: contribuicao.total };
  Object.entries(valores).forEach(([campo, valor]) => {
    somar(acumulador, ['dias', dia, canal, campo], sinal * valor);
    somar(acumulador, ['horas', hora, canal, campo], sinal * valor);
    if (campo !== 'frete') somar(acumulador, ['semanaHora', semanaHora, campo], sinal * valor);
  });
  Object.entries(contribuicao.produtos).forEach(([chave, produto]) => {
    somar(acumulador, ['produtos', chave, 'qtd'], sinal * produto.qtd);
    somar(acumulador, ['produtos', chave, 'valor'], sinal * produto.valor);
    if (sinal > 0) nomear(acumulador, ['produtos', chave, 'nome'], produto.nome);
  });
  Object.entries(contribuicao.categorias).forEach(([chave, categoria]) => {
    somar(acumulador, ['categorias', chave, 'qtd'], sinal * categoria.qtd);
    somar(acumulador, ['categorias', chave, 'valor'], sinal * categoria.valor);
    if (sinal > 0) nomear(acumulador, ['categorias', chave, 'nome'], categoria.nome);
  });
  const { cliente, bairro } = contribuicao;
  somar(acumulador, ['clientes', cliente.chave, 'pedidos'], sinal);
  somar(acumulador, ['clientes', cliente.chave, 'valor'], sinal * cliente.valor);
  if (sinal > 0) nomear(acumulador, ['clientes', cliente.chave, 'nome'], cliente.nome);
  if (bairro) {
    somar(acumulador, ['bairros', bairro.chave, 'pedidos'], sinal);
    if (sinal > 0) nomear(acumulador, ['bairros', bairro.chave, 'nome'], bairro.nome);
  }
}

// Poe (sinal 1) ou tira (sinal -1) uma contribuicao no acumulador do dia dela.
function aplicarNoDia(acumulador, contribuicao, sinal) {
  const { hora, canal } = contribuicao;
  somar(acumulador, ['horas', hora, canal, 'price'], sinal * contribuicao.price);
  somar(acumulador, ['horas', hora, canal, 'pedidos'], sinal);
}

// Id do documento do dia: 'AAAA-MM-DD' no fuso de Sao Paulo.
function idDoDia(contribuicao) {
  return `${contribuicao.mes}-${contribuicao.dia}`;
}

// Objeto aninhado para set com merge: o id nunca vira caminho com ponto.
function objetoDoAcumulador(acumulador, FieldValue) {
  const raiz = {};
  const por = (caminho, valor) => {
    let alvo = raiz;
    caminho.slice(0, -1).forEach((parte) => { alvo[parte] = alvo[parte] || {}; alvo = alvo[parte]; });
    alvo[caminho.at(-1)] = valor;
  };
  acumulador.deltas.forEach((delta, chave) => {
    if (Math.abs(delta) > 1e-9) por(JSON.parse(chave), FieldValue.increment(delta));
  });
  acumulador.nomes.forEach((nome, chave) => por(JSON.parse(chave), nome));
  return raiz;
}

// ----- Leitura dos documentos de produto e de categoria que faltam -----

// Produto ja visto na contribuicao antiga nao e lido de novo: nome e categorias vem dela.
async function carregarMeta({ db, lojaId, data, antiga = null }) {
  const produtos = new Map();
  const categorias = new Map();
  Object.entries(antiga?.metaProdutos || {}).forEach(([id, meta]) => produtos.set(id, meta));
  Object.entries(antiga?.categorias || {}).forEach(([id, categoria]) => categorias.set(id, categoria.nome));

  const loja = db.collection('estabelecimentos').doc(lojaId);
  const faltando = [...new Set((data.productsCart || data.items || [])
    .filter(itemPrecisaDoProduto)
    .map(itemProductId)
    .filter((id) => !produtos.has(id)))];
  if (faltando.length) {
    const snapshots = await db.getAll(...faltando.map((id) => loja.collection('Products').doc(id)));
    snapshots.forEach((snapshot) => {
      const dados = snapshot.exists ? snapshot.data() : {};
      produtos.set(snapshot.id, {
        name: dados.name || null,
        categoriesIds: Array.isArray(dados.categoriesIds) ? dados.categoriesIds : [],
        shelves: Array.isArray(dados.shelves) ? dados.shelves.map((shelf) => ({ productCategoryId: shelf.productCategoryId || shelf.categoryId || null })) : [],
      });
    });
  }

  const categoriasFaltando = [...new Set([...produtos.values()]
    .flatMap((meta) => itemCategoryIds({}, meta).map(refId).filter(Boolean))
    .filter((id) => !categorias.has(id)))];
  if (categoriasFaltando.length) {
    const snapshots = await db.getAll(...categoriasFaltando.map((id) => loja.collection('ProductCategories').doc(id)));
    snapshots.forEach((snapshot) => categorias.set(snapshot.id, snapshot.exists ? snapshot.get('name') || null : null));
  }
  return { produtos, categorias };
}

// Contribuicao pronta para guardar: a soma e a meta dos produtos usados, para a proxima
// gravacao do pedido nao reler o que ja sabe.
async function contribuicaoComMeta({ db, lojaId, pedidoId, data, antiga }) {
  if (!ehVenda(data)) return null;
  const meta = await carregarMeta({ db, lojaId, data, antiga });
  const contribuicao = contribuicaoDoPedido(pedidoId, data, meta);
  if (!contribuicao) return null;
  const metaProdutos = {};
  (data.productsCart || data.items || []).forEach((item) => {
    const id = itemProductId(item);
    if (id && meta.produtos.has(id)) metaProdutos[id] = meta.produtos.get(id);
  });
  return { ...contribuicao, metaProdutos };
}

// Texto estavel da contribuicao, sem a meta e sem as marcas de gravacao: o Firestore
// devolve as chaves dos mapas em outra ordem, entao a comparacao ordena as chaves.
function estavel(valor) {
  if (Array.isArray(valor)) return `[${valor.map(estavel).join(',')}]`;
  if (valor && typeof valor === 'object') {
    return `{${Object.keys(valor).sort().map((chave) => `${JSON.stringify(chave)}:${estavel(valor[chave])}`).join(',')}}`;
  }
  return JSON.stringify(valor ?? null);
}

function semMeta(contribuicao) {
  if (!contribuicao) return 'null';
  const { metaProdutos, versaoResumo, atualizadoEm, ...resto } = contribuicao;
  return estavel(resto);
}

// ----- Gatilho -----

function referencias(db, lojaId, pedidoId) {
  const loja = db.collection('estabelecimentos').doc(lojaId);
  return {
    contribuicao: loja.collection(CONTRIBUICOES_COLLECTION).doc(pedidoId),
    mes: (mes) => loja.collection(RESUMO_VENDAS_COLLECTION).doc(mes),
    dia: (dia) => loja.collection(RESUMO_VENDAS_DIA_COLLECTION).doc(dia),
  };
}

// Tira a contribuicao antiga e poe a nova, numa transacao. Loja de antes e de depois vem
// de lojaDe (extractCompanyId do gatilho).
async function atualizarResumoDeVendas({ db, FieldValue, antes = null, depois = null, pedidoId, lojaDe }) {
  const lojaAntiga = antes && lojaDe(antes) ? String(lojaDe(antes)) : null;
  const lojaNova = depois && lojaDe(depois) ? String(lojaDe(depois)) : null;
  if (!lojaAntiga && !lojaNova) return { acao: 'nada', lojas: [] };
  // Nem antes nem depois era venda: nao le nada.
  if (!ehVenda(antes) && !ehVenda(depois)) return { acao: 'nada', lojas: [] };

  const lojasTocadas = new Set();
  const resultado = await db.runTransaction(async (transacao) => {
    const refAntiga = lojaAntiga ? referencias(db, lojaAntiga, pedidoId) : null;
    const refNova = lojaNova ? referencias(db, lojaNova, pedidoId) : null;
    const trocouDeLoja = Boolean(lojaNova && lojaNova !== lojaAntiga);
    const [snapAntiga, snapNova] = await Promise.all([
      refAntiga ? transacao.get(refAntiga.contribuicao) : null,
      trocouDeLoja ? transacao.get(refNova.contribuicao) : null,
    ]);
    const guardadaAntiga = snapAntiga?.exists ? snapAntiga.data() : null;
    const guardadaNaNova = trocouDeLoja ? (snapNova?.exists ? snapNova.data() : null) : guardadaAntiga;
    const nova = lojaNova
      ? await contribuicaoComMeta({ db, lojaId: lojaNova, pedidoId, data: depois, antiga: guardadaNaNova })
      : null;

    if (!trocouDeLoja && semMeta(guardadaAntiga) === semMeta(nova)) return 'nada';

    const porMes = new Map();
    const porDia = new Map();
    const acumuladorEm = (mapa, lojaId, id) => {
      const chave = `${lojaId}|${id}`;
      if (!mapa.has(chave)) mapa.set(chave, { lojaId, id, acumulador: novoAcumulador() });
      return mapa.get(chave).acumulador;
    };
    const aplicarNaLoja = (lojaId, contribuicao, sinal) => {
      aplicar(acumuladorEm(porMes, lojaId, contribuicao.mes), contribuicao, sinal);
      aplicarNoDia(acumuladorEm(porDia, lojaId, idDoDia(contribuicao)), contribuicao, sinal);
    };
    // Tira tudo o que o pedido somou em qualquer loja e poe de novo onde ele esta agora.
    [[lojaAntiga, guardadaAntiga], [trocouDeLoja ? lojaNova : null, trocouDeLoja ? guardadaNaNova : null]]
      .forEach(([lojaId, guardada]) => {
        if (lojaId && guardada) aplicarNaLoja(String(lojaId), guardada, -1);
      });
    if (nova) aplicarNaLoja(String(lojaNova), nova, 1);

    porMes.forEach(({ lojaId, id, acumulador }) => {
      const objeto = objetoDoAcumulador(acumulador, FieldValue);
      transacao.set(referencias(db, lojaId, pedidoId).mes(id), {
        ...objeto,
        versaoResumo: RESUMO_VENDAS_VERSION,
        atualizadoEm: FieldValue.serverTimestamp(),
      }, { merge: true });
      lojasTocadas.add(lojaId);
    });
    // Dia sem delta (so produto ou frete mudou) nao e gravado.
    porDia.forEach(({ lojaId, id, acumulador }) => {
      const objeto = objetoDoAcumulador(acumulador, FieldValue);
      if (!Object.keys(objeto).length) return;
      transacao.set(referencias(db, lojaId, pedidoId).dia(id), {
        ...objeto,
        versaoResumo: RESUMO_VENDAS_VERSION,
        atualizadoEm: FieldValue.serverTimestamp(),
      }, { merge: true });
      lojasTocadas.add(lojaId);
    });

    if (guardadaAntiga && (!nova || trocouDeLoja)) transacao.delete(refAntiga.contribuicao);
    if (trocouDeLoja && guardadaNaNova && !nova) transacao.delete(refNova.contribuicao);
    if (nova) {
      transacao.set(refNova.contribuicao, {
        ...nova, versaoResumo: RESUMO_VENDAS_VERSION, atualizadoEm: FieldValue.serverTimestamp(),
      });
      lojasTocadas.add(String(lojaNova));
    }
    return nova ? 'gravou' : 'removeu';
  });

  if (resultado === 'nada') return { acao: 'nada', lojas: [] };
  const lojas = [...lojasTocadas];
  await Promise.all(lojas.map((lojaId) => marcarMudanca({ db, FieldValue, lojaId, tipo: 'vendas' })));
  return { acao: resultado, lojas };
}

// ----- Montagem inteira (script) -----

// Documentos (id -> dados) a partir de todas as contribuicoes da loja, ja somados.
function montarDocumentos(contribuicoes, idDe, aplicarEm) {
  const acumuladores = new Map();
  contribuicoes.forEach((contribuicao) => {
    const id = idDe(contribuicao);
    if (!acumuladores.has(id)) acumuladores.set(id, novoAcumulador());
    aplicarEm(acumuladores.get(id), contribuicao, 1);
  });
  const documentos = new Map();
  acumuladores.forEach((acumulador, id) => {
    // Sem FieldValue: o valor somado vai direto.
    const raiz = {};
    const por = (caminho, valor) => {
      let alvo = raiz;
      caminho.slice(0, -1).forEach((parte) => { alvo[parte] = alvo[parte] || {}; alvo = alvo[parte]; });
      alvo[caminho.at(-1)] = valor;
    };
    acumulador.deltas.forEach((valor, chave) => por(JSON.parse(chave), valor));
    acumulador.nomes.forEach((nome, chave) => por(JSON.parse(chave), nome));
    documentos.set(id, raiz);
  });
  return documentos;
}

function montarMeses(contribuicoes) {
  return montarDocumentos(contribuicoes, (contribuicao) => contribuicao.mes, aplicar);
}

function montarDias(contribuicoes) {
  return montarDocumentos(contribuicoes, idDoDia, aplicarNoDia);
}

module.exports = {
  CONTRIBUICOES_COLLECTION,
  RESUMO_VENDAS_COLLECTION,
  RESUMO_VENDAS_DIA_COLLECTION,
  RESUMO_VENDAS_VERSION,
  atualizarResumoDeVendas,
  carregarMeta,
  contribuicaoComMeta,
  contribuicaoDoPedido,
  dataDaVenda,
  ehVenda,
  idDoDia,
  momentoDaVenda,
  montarDias,
  montarMeses,
};
