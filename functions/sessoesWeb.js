// Item 5.10 "Acessos conectados" (plano construcao-acessos-conectados.md): rotina diaria que tira o
// navegador sem uso ha 7 dias. A sessao com ultimoUso de mais de 7 dias sai da lista do Admin e o
// documento estabelecimentos/{loja}/SessoesWeb/{sessaoId} e apagado (com ele, o IP). O Core trata
// sessao apagada como encerrada (motivo sem_uso_7_dias): o navegador recebe 401 sessao_encerrada e
// volta ao login. IpsNomeados fica (e o nome que o Admin deu ao IP).
//
// Arquivo puro: recebe o banco e a hora por parametro. So conta no log; nunca registra IP nem id.
const ORIGEM = 'limparSessoesWebSemUso';
const DIAS_SEM_USO = 7;
const LOTE = 400;

function limiteDeUso(agora) {
  return new Date(agora.getTime() - DIAS_SEM_USO * 24 * 60 * 60 * 1000);
}

async function limparSessoesSemUsoDaLoja({ db, lojaId, agora }) {
  const velhas = await db
    .collection('estabelecimentos').doc(lojaId).collection('SessoesWeb')
    .where('ultimoUso', '<', limiteDeUso(agora))
    .get();
  let apagadas = 0;
  for (let i = 0; i < velhas.docs.length; i += LOTE) {
    const lote = db.batch();
    velhas.docs.slice(i, i + LOTE).forEach((doc) => lote.delete(doc.ref));
    // eslint-disable-next-line no-await-in-loop
    await lote.commit();
    apagadas += Math.min(LOTE, velhas.docs.length - i);
  }
  return { apagadas };
}

module.exports = {
  ORIGEM, DIAS_SEM_USO, limiteDeUso, limparSessoesSemUsoDaLoja,
};
