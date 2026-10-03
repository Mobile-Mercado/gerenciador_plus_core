// Lista "Sem giro" do Financeiro, pronta, em estabelecimentos/{loja}/Stats/semGiro.
//
// Existe para a tabela parar de ler o espelho inteiro do catalogo (Stats/catalogoEspelho,
// 2.872 KB na Zero Grau em 03/10/2026) a cada abertura so para listar seis produtos.
//
// REGRA COPIADA do painel (web_gerenciador_plus/src/features/dashboard/useFinanceBridge.js,
// renderProductBreakdown, com rankingDoPeriodo de resumoVendas.js e o catalogo do espelho):
//   - catalogo: produtos com isTrashed == false, na ordem do id do documento, como o
//     espelho (catalogoEspelho.js) le;
//   - vendidos: produtos do ResumoVendas do mes atual e do anterior com qtd somada maior
//     que zero;
//   - entram os produtos com isActive === true que nao foram vendidos;
//   - nome: name ou, sem ele, o id; estoque: quantityInStock quando e numero, senao 0;
//   - ordem: estoque do maior para o menor (empate fica na ordem do catalogo);
//   - a tabela mostra SEM_GIRO_LIMIT = 6 linhas.
// Mudou a regra la, muda aqui.
//
// Arquivo puro: nao requer firebase-admin nem firebase-functions. Para gravar, recebe db e
// o FieldValue de quem chamou.
const SEM_GIRO_VERSION = 1;
const SEM_GIRO_DOCUMENT = 'semGiro';
const SEM_GIRO_LIMIT = 6;
const TIME_ZONE = 'America/Sao_Paulo';
const CAMPOS_DO_PRODUTO = Object.freeze(['name', 'isActive', 'isTrashed', 'quantityInStock']);

function numero(valor) {
  const parsed = Number(valor);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Estoque como o espelho grava (numero ou null) e o painel le (null vira 0).
function estoqueDe(produto) {
  const valor = produto?.quantityInStock;
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

// Ids vendidos nos documentos de ResumoVendas: qtd somada maior que zero.
function idsVendidos(resumos) {
  const qtdPorId = new Map();
  resumos.filter(Boolean).forEach((resumo) => {
    Object.entries(resumo?.produtos || {}).forEach(([id, entrada]) => {
      qtdPorId.set(id, (qtdPorId.get(id) || 0) + numero(entrada?.qtd));
    });
  });
  return new Set([...qtdPorId].filter(([, qtd]) => qtd > 0).map(([id]) => id));
}

// produtos: [{ id, name, isActive, isTrashed, quantityInStock }] na ordem do catalogo.
function calcularSemGiro({ produtos = [], resumoMesAtual = null, resumoMesAnterior = null, limite = SEM_GIRO_LIMIT }) {
  const vendidos = idsVendidos([resumoMesAtual, resumoMesAnterior]);
  const parados = produtos
    .filter((produto) => produto && produto.isTrashed !== true)
    .filter((produto) => produto.isActive === true && !vendidos.has(produto.id))
    .map((produto) => ({ id: produto.id, nome: produto.name || produto.id, estoque: estoqueDe(produto) }))
    .sort((a, b) => b.estoque - a.estoque);
  return { produtos: parados.slice(0, limite), total: parados.length };
}

const formatadorDeMes = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit' });

// Mes atual e anterior, 'AAAA-MM', no fuso de Sao Paulo.
function mesesDaLista(agora = new Date()) {
  const partes = {};
  formatadorDeMes.formatToParts(agora).forEach(({ type, value }) => { partes[type] = value; });
  const ano = Number(partes.year);
  const mes = Number(partes.month);
  const anterior = mes === 1 ? [ano - 1, 12] : [ano, mes - 1];
  const id = (a, m) => `${a}-${String(m).padStart(2, '0')}`;
  return [id(ano, mes), id(...anterior)];
}

// Le o catalogo so com os campos usados e os dois meses de ResumoVendas, e grava a lista.
async function atualizarSemGiro({ db, FieldValue, lojaId, agora = new Date(), gravar = true }) {
  const loja = db.collection('estabelecimentos').doc(lojaId);
  const meses = mesesDaLista(agora);
  const [catalogo, mesAtual, mesAnterior] = await Promise.all([
    loja.collection('Products').where('isTrashed', '==', false).select(...CAMPOS_DO_PRODUTO).get(),
    loja.collection('ResumoVendas').doc(meses[0]).get(),
    loja.collection('ResumoVendas').doc(meses[1]).get(),
  ]);
  const produtos = catalogo.docs.map((documento) => ({ id: documento.id, ...documento.data() }));
  const lista = calcularSemGiro({
    produtos,
    resumoMesAtual: mesAtual.exists ? mesAtual.data() : null,
    resumoMesAnterior: mesAnterior.exists ? mesAnterior.data() : null,
  });
  const documento = { ...lista, meses, versao: SEM_GIRO_VERSION };
  if (gravar) {
    await loja.collection('Stats').doc(SEM_GIRO_DOCUMENT).set({ ...documento, atualizadoEm: FieldValue.serverTimestamp() });
  }
  return { ...documento, catalogo: produtos.length };
}

module.exports = {
  CAMPOS_DO_PRODUTO,
  SEM_GIRO_DOCUMENT,
  SEM_GIRO_LIMIT,
  SEM_GIRO_VERSION,
  atualizarSemGiro,
  calcularSemGiro,
  mesesDaLista,
};
