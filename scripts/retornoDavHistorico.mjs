// Item 5.13: preenche ReturnSales.entregueEm (hora em que saiu para o caixa) dos pedidos de antes da
// 4.20, deduzida do registro de getSalesFromCompany (30 dias). So simula, sem --gravar.
// Uso: node scripts/retornoDavHistorico.mjs <lojaId> [--gravar]
// Precisa de gcloud logado com leitura do Logging e do Firestore. Nao imprime dado de cliente.
// Nao toca em pedido com aguardaGravacao, gravadoEm, entregueSemConfirmacaoEm, entregueEm ou reenvio.
import { execSync } from 'node:child_process';
import { deduzirEntregas } from '../src/domain/retornoDav/entregaPeloRegistro.js';
import { numeroDoPedido, puladosPelaRegraDoNumero } from '../src/domain/retornoDav/situacaoDoRetorno.js';

const PROJETO = process.env.FIRESTORE_PROJECT_ID || 'appmobileprod-19505';
const [lojaId, opcao] = process.argv.slice(2);
if (!lojaId || lojaId.includes('/')) throw new Error('uso: node scripts/retornoDavHistorico.mjs <lojaId> [--gravar]');
const gravar = opcao === '--gravar';
const token = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const cabecalhos = { Authorization: `Bearer ${token}`, 'x-goog-user-project': PROJETO, 'Content-Type': 'application/json' };
const base = `https://firestore.googleapis.com/v1/projects/${PROJETO}/databases/(default)/documents`;
const valor = (x) => { if (!x) return null; const [tipo, v] = Object.entries(x)[0]; return tipo === 'nullValue' ? null : v; };

const campos = ['numeroPedido', 'aguardaGravacao', 'gravadoEm', 'entregueSemConfirmacaoEm', 'entregueEm', 'reenvio'];
const lidos = await (await fetch(`${base}/estabelecimentos/${lojaId}/ReturnSales?pageSize=1000&${campos.map((c) => `mask.fieldPaths=${c}`).join('&')}`, { headers: cabecalhos })).json();
const vendas = (lidos.documents ?? []).map((d) => ({
  id: d.name.split('/').pop(),
  numero: numeroDoPedido(valor(d.fields?.numeroPedido)),
  prontoEm: new Date(d.createTime),
  campos: Object.keys(d.fields ?? {}),
}));
const intocadas = vendas.filter((v) => !v.campos.some((c) => ['aguardaGravacao', 'gravadoEm', 'entregueSemConfirmacaoEm', 'entregueEm', 'reenvio'].includes(c)));

const desde = new Date(Date.now() - 30 * 86_400_000).toISOString();
const buscas = [];
let pagina;
do {
  const r = await (await fetch('https://logging.googleapis.com/v2/entries:list', {
    method: 'POST', headers: cabecalhos,
    body: JSON.stringify({ resourceNames: [`projects/${PROJETO}`], filter: `timestamp>="${desde}" AND resource.type="cloud_run_revision" AND resource.labels.service_name="getsalesfromcompany" AND httpRequest.requestUrl:"${lojaId}"`, pageSize: 1000, orderBy: 'timestamp asc', ...(pagina ? { pageToken: pagina } : {}) }),
  })).json();
  for (const e of r.entries ?? []) {
    if (!e.httpRequest?.status) continue;
    const url = new URL(e.httpRequest.requestUrl);
    buscas.push({ em: new Date(e.timestamp), ultimo: Number(url.searchParams.get('numeroPedido') ?? -1), status: e.httpRequest.status, bytes: Number(e.httpRequest.responseSize ?? 0) });
  }
  pagina = r.nextPageToken;
} while (pagina);

const pulados = puladosPelaRegraDoNumero(vendas);
const entregas = deduzirEntregas(intocadas.filter((v) => !pulados.has(v.id)), buscas);
console.log(`vendas ${vendas.length} | sem campo da 4.20 ${intocadas.length} | nao enviadas pela regra do numero ${[...pulados].filter((id) => intocadas.some((v) => v.id === id)).length} | com hora deduzida ${entregas.size} | buscas no registro ${buscas.length}`);
for (const venda of intocadas.filter((v) => entregas.has(v.id))) console.log(`  pedido ${venda.numero}: entregue ${entregas.get(venda.id).toISOString()}`);
if (!gravar) {
  console.log('Simulacao: nada gravado. Para gravar: --gravar');
  process.exit(0);
}
for (const [id, em] of entregas) {
  const url = `${base}/estabelecimentos/${lojaId}/ReturnSales/${id}?updateMask.fieldPaths=entregueEm&updateMask.fieldPaths=entregaDeduzida&currentDocument.exists=true`;
  const r = await fetch(url, { method: 'PATCH', headers: cabecalhos, body: JSON.stringify({ fields: { entregueEm: { timestampValue: em.toISOString() }, entregaDeduzida: { booleanValue: true } } }) });
  console.log(`  ${id.slice(0, 6)}: ${r.status}`);
}
