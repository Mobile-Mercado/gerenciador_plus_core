// Gravacao 2 (cola RP-76; decidida na RP-16, item 2c): na G&S o cartao passa a se chamar
// "Cartao de credito", no array paymentMethods[] da loja e na subcolecao paymentMethods. A loja nao
// aceita debito (Safrapay sem debito). So muda o nome dos itens que falam em debito; o resto do
// item (id, isActive, order, icon) e os outros itens ficam como estao.
const { lerValor, valorNoCaminho, valorRest } = require('../firestoreRest');

const G_E_S = 'GkFYWdOBKD1vbzYoem9K';
const NOME_DO_CARTAO = 'Cartão de crédito';
const falaEmDebito = (nome) => /d[eé]bito|debit/i.test(String(nome || ''));

function mudancasDoCartao(loja, formas) {
  const mudancas = [];
  const lista = valorNoCaminho(loja.campos, 'paymentMethods');
  const itens = lista?.arrayValue?.values || [];
  if (itens.some((item) => falaEmDebito(lerValor(item?.mapValue?.fields?.name)))) {
    const nova = itens.map((item) => (falaEmDebito(lerValor(item?.mapValue?.fields?.name))
      ? { mapValue: { fields: { ...item.mapValue.fields, name: valorRest(NOME_DO_CARTAO) } } }
      : item));
    mudancas.push({
      caminho: loja.caminho, rotulo: 'G&S, array paymentMethods[]', updateTime: loja.updateTime,
      antes: { paymentMethods: lista }, depois: { paymentMethods: { arrayValue: { values: nova } } },
    });
  }
  formas.filter((forma) => falaEmDebito(lerValor(valorNoCaminho(forma.campos, 'name')))).forEach((forma) => {
    mudancas.push({
      caminho: forma.caminho, rotulo: `G&S, subcolecao paymentMethods/${forma.id}`, updateTime: forma.updateTime,
      antes: { name: valorNoCaminho(forma.campos, 'name') }, depois: { name: valorRest(NOME_DO_CARTAO) },
    });
  });
  return mudancas;
}

async function executar({ firestore }) {
  const caminho = `estabelecimentos/${G_E_S}`;
  const loja = (await firestore.obter([caminho], ['paymentMethods'])).get(caminho);
  if (!loja) return { lidos: 0, mudancas: [], avisos: [`loja ${G_E_S} nao encontrada`], bloqueio: 'loja nao encontrada' };
  const formas = await firestore.listar(`${caminho}/paymentMethods`, ['name']);
  const mudancas = mudancasDoCartao(loja, formas);
  return {
    lidos: 1 + formas.length,
    mudancas,
    avisos: mudancas.length ? [] : ['nenhum cartao com debito no nome: nada a mudar'],
  };
}

module.exports = {
  descricao: 'G&S: o cartao passa a se chamar "Cartão de crédito" (array paymentMethods[] e subcolecao paymentMethods).',
  executar,
  mudancasDoCartao,
};
