// Contrato do registro "um integrador por loja" (cola 65, item 4.11; contrato comum em
// D:\ferramentas-integrador\contrato-4.11-4.6.md): documento
// estabelecimentos/{companyId}/IntegradorDaLoja/atual
// { maquina, registradoEm, ultimoUsoEm, trocaLiberadaEm: null|Timestamp, trocaLiberadaPor: null|uid }.
//
// liberarTroca({ lojaId, adminUid }) grava trocaLiberadaEm (hora do servidor) e trocaLiberadaPor e
// devolve { lojaExiste, computadorRegistrado }. Loja inexistente: nada e gravado.
//
// lerComputador({ lojaId }) (cola 70, card "Computador do integrador" no Admin) devolve
// { lojaExiste, registro, status }: registro e o documento IntegradorDaLoja/atual (ou null) e status
// e estabelecimentos/{id}/IntegrationStatus/current (ou null), como estao no banco.
export class IntegradorDaLojaRepository {
  async liberarTroca() {
    throw new Error('IntegradorDaLojaRepository.liberarTroca precisa ser implementado.');
  }

  async lerComputador() {
    throw new Error('IntegradorDaLojaRepository.lerComputador precisa ser implementado.');
  }
}
