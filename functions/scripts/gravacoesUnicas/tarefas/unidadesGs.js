// Gravacao 4 (cola RP-76; decisoes do Thay de 29/10 nas RP-68 e RP-69): unidade dos produtos da
// G&S, por lote, sempre com --lote:
//   lata       5 produtos com unitType "LT" -> ProductUnitType.lata (piloto: roda primeiro)
//   kg-pacote  15 produtos com unitType "KG" e unitQuantity maior que 1 (pacotes de 250 g a 800 g
//              vendidos por unidade) -> ProductUnitType.unidade
//   pc         77 produtos com unitType "PC", "Pc" ou "pc" -> ProductUnitType.unidade
// Grava so unitType (nunca unityType nem updatedAt), com a conferencia pelo updateTime (regra da
// RP-67, D.2). A contagem tem de bater com a das RP-67/RP-69; se nao bater, a gravacao e recusada
// (--esperado N aceita outro numero, depois de conferir). kg-pacote e pc so gravam depois do piloto:
// com algum produto ainda em "LT", a gravacao e recusada.
//
// O integrador nao desfaz: ele nunca grava unitType (so unityType e unitQuantity no produto que ja
// existe, build-product-update.ts do mobile_old_web_platform). Ver o relatorio da RP-76.
const { lerCampos, valorRest } = require('../firestoreRest');
const { argumento } = require('../comum');

const G_E_S = 'GkFYWdOBKD1vbzYoem9K';
const CAMPOS = ['unitType', 'unityType', 'unitQuantity', 'name', 'isActive', 'barCode'];

const LOTES = Object.freeze({
  lata: { esperado: 5, novo: 'ProductUnitType.lata', entra: (produto) => produto.unitType === 'LT' },
  'kg-pacote': {
    esperado: 15, novo: 'ProductUnitType.unidade',
    entra: (produto) => produto.unitType === 'KG' && Number(produto.unitQuantity) > 1,
  },
  pc: { esperado: 77, novo: 'ProductUnitType.unidade', entra: (produto) => /^pc$/i.test(String(produto.unitType || '')) },
});

function mudancasDoLote(nomeDoLote, documentos) {
  const lote = LOTES[nomeDoLote];
  const produtos = documentos.map((documento) => ({ documento, dados: lerCampos(documento.campos) }));
  const codigos = new Map();
  produtos.forEach(({ dados }) => { if (dados.barCode) codigos.set(dados.barCode, (codigos.get(dados.barCode) || 0) + 1); });
  const alvos = produtos.filter(({ dados }) => lote.entra(dados));
  const mudancas = alvos.map(({ documento, dados }) => ({
    caminho: documento.caminho,
    rotulo: `${dados.name || '(sem nome)'} | unityType ${dados.unityType ?? '(ausente)'} | unitQuantity ${dados.unitQuantity ?? '(ausente)'} | ${dados.isActive === false ? 'inativo' : 'ativo'}`,
    updateTime: documento.updateTime,
    antes: { unitType: documento.campos.unitType },
    depois: { unitType: valorRest(lote.novo) },
  }));
  const repetidos = alvos.filter(({ dados }) => dados.barCode && codigos.get(dados.barCode) > 1).length;
  const aindaEmLt = produtos.filter(({ dados }) => dados.unitType === 'LT').length;
  return { mudancas, repetidos, aindaEmLt };
}

async function executar({ firestore, lote: nomeDoLote }) {
  const lote = LOTES[nomeDoLote];
  if (!lote) throw new Error(`Use --lote ${Object.keys(LOTES).join(' | ')} (lata primeiro: e o piloto)`);
  const documentos = await firestore.listar(`estabelecimentos/${G_E_S}/Products`, CAMPOS);
  const { mudancas, repetidos, aindaEmLt } = mudancasDoLote(nomeDoLote, documentos);
  const esperado = argumento('esperado') ? Number(argumento('esperado')) : lote.esperado;
  const avisos = [`G&S: ${documentos.length} produtos lidos; lote ${nomeDoLote}: ${mudancas.length} (esperado ${esperado}) -> unitType ${lote.novo}`];
  if (repetidos) avisos.push(`${repetidos} produtos do lote com codigo de barras repetido na loja (o integrador apaga o duplicado mais novo)`);
  let bloqueio = null;
  if (mudancas.length !== esperado) {
    bloqueio = `o lote ${nomeDoLote} tem ${mudancas.length} produtos, esperado ${esperado} (RP-67/RP-69). Confira antes; para aceitar, --esperado ${mudancas.length}.`;
  } else if (nomeDoLote !== 'lata' && aindaEmLt > 0) {
    bloqueio = `o piloto (lote lata) ainda nao rodou: ${aindaEmLt} produtos com unitType "LT".`;
  }
  if (bloqueio) avisos.push(`a gravacao seria recusada: ${bloqueio}`);
  return { lidos: documentos.length, mudancas, avisos, bloqueio, sufixo: nomeDoLote };
}

module.exports = {
  descricao: 'G&S: unitType dos produtos por lote (lata: LT -> ProductUnitType.lata; kg-pacote e pc -> ProductUnitType.unidade). So unitType.',
  LOTES,
  executar,
  mudancasDoLote,
};
