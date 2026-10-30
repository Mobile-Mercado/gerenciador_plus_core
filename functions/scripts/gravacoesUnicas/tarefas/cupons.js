// Gravacao 1 (cola RP-76; decidida na RP-16, item 2a): cupons sem tipo ganham tipo 'todos'.
// A consulta do app da versao 55 le "para todos" com where('tipo', '==', 'todos'): cupom sem tipo
// some do app. Cupom sem tipo mas com destinatario ou targetClientId (cupom de um cliente) fica de
// fora e e avisado, para decidir a mao. Le so tipo, targetClientId e os ids do destinatario.
const { AUSENTE, lerValor, valorNoCaminho, valorRest } = require('../firestoreRest');

const CAMPOS = ['tipo', 'targetClientId', 'destinatario.userId', 'destinatario.userAuthId'];

function mudancasDosCupons(documentos) {
  const mudancas = [];
  const avisos = [];
  documentos.forEach((cupom) => {
    const tipo = valorNoCaminho(cupom.campos, 'tipo');
    if (lerValor(tipo)) return;
    const comCliente = ['targetClientId', 'destinatario.userId', 'destinatario.userAuthId']
      .some((campo) => lerValor(valorNoCaminho(cupom.campos, campo)));
    if (comCliente) {
      avisos.push(`cupom ${cupom.id} sem tipo, mas com cliente: fica de fora (decidir a mao)`);
      return;
    }
    mudancas.push({
      caminho: cupom.caminho,
      rotulo: null,
      updateTime: cupom.updateTime,
      antes: { tipo: tipo ?? AUSENTE },
      depois: { tipo: valorRest('todos') },
    });
  });
  return { mudancas, avisos };
}

async function executar({ firestore }) {
  const documentos = await firestore.listar('Coupons', CAMPOS);
  return { lidos: documentos.length, ...mudancasDosCupons(documentos) };
}

module.exports = {
  descricao: "Cupons sem tipo ganham tipo 'todos' (cupom com cliente fica de fora).",
  executar,
  mudancasDosCupons,
};
