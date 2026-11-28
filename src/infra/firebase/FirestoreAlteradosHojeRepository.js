import { Timestamp } from 'firebase-admin/firestore';

// Cola 100, item 6: itens das cargas do integrador desde o comeco do dia
// (estabelecimentos/{loja}/IntegrationLogItems, gravados pela nuvem a cada carga). Le so os campos
// da contagem, sem nome do produto; em paginas, pela data do item (indice simples de "at").
export const ITENS_DO_INTEGRADOR = 'IntegrationLogItems';
const CAMPOS = [
  'barCode', 'externalId', 'action', 'priceFrom', 'priceTo', 'stockFrom', 'stockTo',
  'activeFrom', 'activeTo', 'trashedFrom', 'trashedTo', 'promotionAction', 'at',
];
const PAGINA = 2000;
const MAXIMO = 60000;

export class FirestoreAlteradosHojeRepository {
  constructor({ firestore, paraData = (data) => Timestamp.fromDate(data), pagina = PAGINA }) {
    this.firestore = firestore;
    this.paraData = paraData;
    this.pagina = pagina;
  }

  async itensDesde({ lojaId, desde }) {
    const colecao = this.firestore.collection('estabelecimentos').doc(lojaId).collection(ITENS_DO_INTEGRADOR);
    const itens = [];
    let ultimo = null;
    while (itens.length < MAXIMO) {
      let consulta = colecao
        .where('at', '>=', this.paraData(desde))
        .orderBy('at')
        .select(...CAMPOS)
        .limit(this.pagina);
      if (ultimo) consulta = consulta.startAfter(ultimo);
      // eslint-disable-next-line no-await-in-loop
      const pagina = await consulta.get();
      pagina.docs.forEach((doc) => itens.push(doc.data()));
      if (pagina.docs.length < this.pagina) break;
      ultimo = pagina.docs[pagina.docs.length - 1];
    }
    return itens;
  }
}
