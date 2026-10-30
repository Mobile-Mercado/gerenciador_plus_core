// Firestore pela API REST, para as gravacoes unicas da versao 55 (cola RP-76).
//
// Por que REST: a previa roda contra a producao com um token do gcloud (FIRESTORE_TOKEN), sem
// arquivo de credencial; e o mesmo codigo roda no emulador (FIRESTORE_EMULATOR_HOST).
//
// Leitura: listar, obter. Gravacao: so com permitirGravacao (o --gravar com --confirmar do
// script). Sem isso, gravar() lanca antes de qualquer chamada: a previa nunca escreve.
// Cada escrita e um update so dos campos da tarefa (updateMask), com a conferencia pelo
// updateTime lido (o documento que mudou depois da leitura vai para falhas, nao e regravado).
//
// Nunca imprime o token.

const PROJETO_PRODUCAO = 'appmobileprod-19505';
const POR_PAGINA = 300;
const POR_LEITURA = 100;
const POR_GRAVACAO = 400;
const MAXIMO_POR_GRAVACAO = 500; // limite do batchWrite
const MAXIMO_DE_PAUSA_MS = 600000;

// Ritmo da gravacao: quantos documentos por chamada do batchWrite e a pausa entre uma chamada e a
// proxima (nao depois da ultima). Sem nada, o padrao de sempre: 400 por chamada, sem pausa.
// Numero invalido para tudo antes de qualquer leitura ou gravacao.
function ritmoDaGravacao({ porChamada, pausaMs } = {}) {
  const inteiro = (valor, nome, minimo, maximo, padrao) => {
    if (valor === undefined || valor === null || valor === '') return padrao;
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero < minimo || numero > maximo) {
      throw new Error(`--${nome} precisa ser um numero inteiro de ${minimo} a ${maximo} (veio ${valor}). Nada foi gravado.`);
    }
    return numero;
  };
  return {
    porChamada: inteiro(porChamada, 'por-chamada', 1, MAXIMO_POR_GRAVACAO, POR_GRAVACAO),
    pausaMs: inteiro(pausaMs, 'pausa-ms', 0, MAXIMO_DE_PAUSA_MS, 0),
  };
}

const esperar = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Valores do Firestore (formato REST) -> JavaScript, so para a logica e a tela da previa.
// A copia guarda o formato REST como veio, para o desfazer voltar o tipo exato.
function lerValor(valor) {
  if (!valor || typeof valor !== 'object') return null;
  if ('nullValue' in valor) return null;
  if ('stringValue' in valor) return valor.stringValue;
  if ('booleanValue' in valor) return valor.booleanValue;
  if ('integerValue' in valor) return Number(valor.integerValue);
  if ('doubleValue' in valor) return Number(valor.doubleValue);
  if ('timestampValue' in valor) return valor.timestampValue;
  if ('referenceValue' in valor) return valor.referenceValue.split('/documents/').pop();
  if ('geoPointValue' in valor) return { ...valor.geoPointValue };
  if ('bytesValue' in valor) return valor.bytesValue;
  if ('arrayValue' in valor) return (valor.arrayValue.values || []).map(lerValor);
  if ('mapValue' in valor) return lerCampos(valor.mapValue.fields);
  return null;
}

function lerCampos(campos = {}) {
  return Object.fromEntries(Object.entries(campos || {}).map(([nome, valor]) => [nome, lerValor(valor)]));
}

// JavaScript -> valor REST (inteiro vira integerValue, como o Admin SDK).
function valorRest(valor) {
  if (valor === null || valor === undefined) return { nullValue: null };
  if (typeof valor === 'string') return { stringValue: valor };
  if (typeof valor === 'boolean') return { booleanValue: valor };
  if (typeof valor === 'number') return Number.isSafeInteger(valor) ? { integerValue: String(valor) } : { doubleValue: valor };
  if (Array.isArray(valor)) return { arrayValue: { values: valor.map(valorRest) } };
  if (typeof valor === 'object') {
    return { mapValue: { fields: Object.fromEntries(Object.entries(valor).map(([nome, item]) => [nome, valorRest(item)])) } };
  }
  throw new Error(`valor nao suportado: ${typeof valor}`);
}

// Marca de "campo ausente" na copia e na gravacao (ausente no depois = apagar o campo).
const AUSENTE = Object.freeze({ _ausente: true });
const ehAusente = (valor) => Boolean(valor && valor._ausente === true);

// Comparacao de valores REST sem depender da ordem das chaves dos mapas. A API devolve mapa e
// lista vazios sem fields/values ({ mapValue: {} }): vale o mesmo que { mapValue: { fields: {} } }.
function canonico(valor) {
  if (Array.isArray(valor)) return valor.map(canonico);
  if (valor && typeof valor === 'object') {
    const completo = { ...valor };
    if (completo.mapValue && !completo.mapValue.fields) completo.mapValue = { fields: {} };
    if (completo.arrayValue && !completo.arrayValue.values) completo.arrayValue = { values: [] };
    return Object.fromEntries(Object.keys(completo).sort().map((chave) => [chave, canonico(completo[chave])]));
  }
  return valor;
}
const iguais = (a, b) => JSON.stringify(canonico(a ?? AUSENTE)) === JSON.stringify(canonico(b ?? AUSENTE));

// Caminho de campo (a.b) no formato da API: segmento fora de [A-Za-z_][A-Za-z0-9_]* vai entre crases.
const caminhoDeCampo = (campo) => campo.split('.')
  .map((parte) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(parte) ? parte : `\`${parte.replace(/[`\\]/g, '\\$&')}\``))
  .join('.');

// Valor de um campo (a.b) dentro dos fields de um documento REST; undefined se ausente.
function valorNoCaminho(campos, campo) {
  let atual = { mapValue: { fields: campos || {} } };
  for (const parte of campo.split('.')) {
    atual = atual?.mapValue?.fields?.[parte];
    if (atual === undefined) return undefined;
  }
  return atual;
}

// fields de um update a partir de { 'a.b': valorRest | AUSENTE }: ausente fica fora dos fields e
// entra so na mascara, o que apaga o campo.
function camposDoUpdate(valores) {
  const raiz = {};
  Object.entries(valores).forEach(([campo, valor]) => {
    if (ehAusente(valor)) return;
    const partes = campo.split('.');
    let alvo = raiz;
    partes.slice(0, -1).forEach((parte) => {
      if (!alvo[parte]) alvo[parte] = { mapValue: { fields: {} } };
      alvo = alvo[parte].mapValue.fields;
    });
    alvo[partes.at(-1)] = valor;
  });
  return raiz;
}

function criarFirestore({ projeto = PROJETO_PRODUCAO, permitirGravacao = false, porChamada, pausaMs } = {}) {
  const ritmo = ritmoDaGravacao({ porChamada, pausaMs });
  const emulador = process.env.FIRESTORE_EMULATOR_HOST || '';
  const token = emulador ? 'owner' : (process.env.FIRESTORE_TOKEN || '');
  if (!token) {
    throw new Error('Sem acesso: defina FIRESTORE_TOKEN (gcloud auth print-access-token) ou FIRESTORE_EMULATOR_HOST.');
  }
  const raiz = `projects/${projeto}/databases/(default)/documents`;
  const servidor = emulador ? `http://${emulador}` : 'https://firestore.googleapis.com';
  const base = `${servidor}/v1/${raiz}`;
  const cabecalhos = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const relativo = (nome) => nome.slice(nome.indexOf('/documents/') + '/documents/'.length);

  async function chamar(metodo, url, corpo) {
    const resposta = await fetch(url, { method: metodo, headers: cabecalhos, body: corpo ? JSON.stringify(corpo) : undefined });
    const texto = await resposta.text();
    if (!resposta.ok) {
      let mensagem = texto.slice(0, 300);
      try { mensagem = JSON.parse(texto).error?.message || mensagem; } catch { /* texto cru */ }
      throw new Error(`Firestore ${metodo} ${resposta.status}: ${mensagem}`);
    }
    return texto ? JSON.parse(texto) : {};
  }

  const mascara = (campos) => (campos || []).map((campo) => `mask.fieldPaths=${encodeURIComponent(caminhoDeCampo(campo))}`).join('&');

  // Todos os documentos de uma colecao (caminho relativo, ex.: estabelecimentos/X/Products), so
  // com os campos da mascara. Devolve { caminho, id, campos (REST), updateTime }.
  async function listar(colecao, campos) {
    const documentos = [];
    let pagina = '';
    do {
      const url = `${base}/${colecao}?pageSize=${POR_PAGINA}${campos ? `&${mascara(campos)}` : ''}${pagina ? `&pageToken=${encodeURIComponent(pagina)}` : ''}`;
      const corpo = await chamar('GET', url);
      (corpo.documents || []).forEach((documento) => {
        const caminho = relativo(documento.name);
        documentos.push({ caminho, id: caminho.split('/').pop(), campos: documento.fields || {}, updateTime: documento.updateTime });
      });
      pagina = corpo.nextPageToken || '';
    } while (pagina);
    return documentos;
  }

  // Varios documentos pelo caminho. Devolve Map(caminho -> documento | null).
  async function obter(caminhos, campos) {
    const resultado = new Map();
    const unicos = [...new Set(caminhos)];
    for (let inicio = 0; inicio < unicos.length; inicio += POR_LEITURA) {
      const corpo = {
        documents: unicos.slice(inicio, inicio + POR_LEITURA).map((caminho) => `${raiz}/${caminho}`),
        ...(campos ? { mask: { fieldPaths: campos.map(caminhoDeCampo) } } : {}),
      };
      const respostas = await chamar('POST', `${base}:batchGet`, corpo);
      respostas.forEach((item) => {
        if (item.found) {
          const caminho = relativo(item.found.name);
          resultado.set(caminho, { caminho, id: caminho.split('/').pop(), campos: item.found.fields || {}, updateTime: item.found.updateTime });
        } else if (item.missing) {
          resultado.set(relativo(item.missing), null);
        }
      });
    }
    return resultado;
  }

  // escritas: [{ caminho, valores: { campo: valorRest | AUSENTE }, updateTime }]. Update so dos
  // campos (nunca set), com a conferencia pelo updateTime. Nao atomico: cada documento volta com
  // ok ou com o erro (ex.: mudou depois da leitura). Vai em chamadas de ritmo.porChamada, com
  // ritmo.pausaMs entre elas; aoTerminarChamada({ chamada, chamadas, gravados, total }) a cada uma.
  async function gravar(escritas, { aoTerminarChamada } = {}) {
    if (!permitirGravacao) throw new Error('Gravacao bloqueada: este acesso e so de leitura.');
    const resultado = [];
    const chamadas = Math.ceil(escritas.length / ritmo.porChamada);
    for (let inicio = 0; inicio < escritas.length; inicio += ritmo.porChamada) {
      if (inicio > 0 && ritmo.pausaMs > 0) await esperar(ritmo.pausaMs);
      const lote = escritas.slice(inicio, inicio + ritmo.porChamada);
      const corpo = {
        writes: lote.map(({ caminho, valores, updateTime }) => ({
          update: { name: `${raiz}/${caminho}`, fields: camposDoUpdate(valores) },
          updateMask: { fieldPaths: Object.keys(valores).map(caminhoDeCampo) },
          currentDocument: updateTime ? { updateTime } : { exists: true },
        })),
      };
      const resposta = await chamar('POST', `${base}:batchWrite`, corpo);
      lote.forEach((escrita, indice) => {
        const status = resposta.status?.[indice] || {};
        resultado.push({ caminho: escrita.caminho, ok: !status.code, erro: status.code ? (status.message || `codigo ${status.code}`) : null });
      });
      if (aoTerminarChamada) {
        aoTerminarChamada({ chamada: inicio / ritmo.porChamada + 1, chamadas, gravados: resultado.length, total: escritas.length });
      }
    }
    return resultado;
  }

  // Interface minima do Admin SDK (collection/doc/getAll/get), para reaproveitar funcoes das
  // functions que leem pelo db (ex.: carregarMeta do resumoDoMes). So leitura, com cache.
  function comoAdmin() {
    const cache = new Map();
    const referencia = (caminho) => ({
      id: caminho.split('/').pop(),
      path: caminho,
      collection: (nome) => colecao(`${caminho}/${nome}`),
    });
    const colecao = (caminho) => ({ doc: (id) => referencia(`${caminho}/${id}`) });
    return {
      collection: (nome) => colecao(nome),
      async getAll(...referencias) {
        const faltam = referencias.map((ref) => ref.path).filter((caminho) => !cache.has(caminho));
        if (faltam.length) (await obter(faltam)).forEach((documento, caminho) => cache.set(caminho, documento));
        return referencias.map((ref) => {
          const documento = cache.get(ref.path) || null;
          const dados = documento ? lerCampos(documento.campos) : undefined;
          return { id: ref.id, ref, exists: Boolean(documento), data: () => dados, get: (campo) => dados?.[campo] };
        });
      },
    };
  }

  return { projeto, emulador: Boolean(emulador), permitirGravacao, ritmo, listar, obter, gravar, comoAdmin };
}

module.exports = {
  AUSENTE,
  PROJETO_PRODUCAO,
  caminhoDeCampo,
  camposDoUpdate,
  criarFirestore,
  ehAusente,
  iguais,
  lerCampos,
  lerValor,
  ritmoDaGravacao,
  valorNoCaminho,
  valorRest,
};
