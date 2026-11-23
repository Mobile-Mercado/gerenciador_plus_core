// Item 5.13: hora em que um pedido de antes da 4.20 saiu para o caixa, deduzida do registro da funcao
// getSalesFromCompany (guardado 30 dias). A chamada do integrador antigo traz so o ultimo numero que
// ele ja tinha (numeroPedido) e o tamanho da resposta, nunca o numero entregue. Entao: o pedido N saiu
// na ultima chamada com resposta com venda (mais de 200 bytes) feita depois de ele ficar pronto e antes
// da primeira chamada com ultimo numero >= N. Sem essa chamada, nao ha hora (o script nao grava).
export const RESPOSTA_COM_VENDA_BYTES = 200;

// vendas: [{ id, numero, prontoEm: Date }]; buscas: [{ em: Date, ultimo: number, status, bytes }] em ordem.
export function deduzirEntregas(vendas, buscas) {
  const ordenadas = [...buscas].sort((a, b) => a.em - b.em);
  const entregas = new Map();
  vendas.forEach((venda) => {
    if (!venda.numero || !venda.prontoEm) return;
    const depois = ordenadas.filter((busca) => busca.em >= venda.prontoEm);
    const limite = depois.findIndex((busca) => busca.ultimo >= venda.numero);
    if (limite <= 0) return;
    const comVenda = depois
      .slice(0, limite)
      .filter((busca) => busca.status === 200 && busca.bytes > RESPOSTA_COM_VENDA_BYTES && busca.ultimo < venda.numero);
    if (comVenda.length) entregas.set(venda.id, comVenda.at(-1).em);
  });
  return entregas;
}
