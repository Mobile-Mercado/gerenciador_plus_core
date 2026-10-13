// Firestore em memoria para os testes dos casos de uso do catalogo e do Admin. Cobre so o
// que eles usam: doc, collection, collectionGroup, where (== e array-contains), orderBy,
// startAfter (snapshot), limit, select, count, getAll, batch, create, set (com merge),
// update (com caminho pontuado) e delete, mais as sentinelas serverTimestamp e delete.

const AGORA = new Date('2026-10-12T15:00:00.000Z');

function copiar(valor) {
  return valor === undefined ? undefined : structuredClone(valor);
}

function ehMapa(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor) && !(valor instanceof Date);
}

function sentinela(valor) {
  return valor?.methodName || '';
}

function resolverValor(valor) {
  if (sentinela(valor) === 'FieldValue.serverTimestamp') return new Date(AGORA);
  if (ehMapa(valor) && !sentinela(valor)) {
    return Object.fromEntries(Object.entries(valor).map(([chave, item]) => [chave, resolverValor(item)]));
  }
  return copiar(valor);
}

function aplicarCampo(alvo, caminho, valor) {
  const partes = caminho.split('.');
  let atual = alvo;
  partes.slice(0, -1).forEach((parte) => {
    if (!ehMapa(atual[parte])) atual[parte] = {};
    atual = atual[parte];
  });
  const ultima = partes.at(-1);
  if (sentinela(valor) === 'FieldValue.delete') delete atual[ultima];
  else atual[ultima] = resolverValor(valor);
}

function mesclar(alvo, dados) {
  Object.entries(dados).forEach(([chave, valor]) => {
    if (sentinela(valor) === 'FieldValue.delete') {
      delete alvo[chave];
    } else if (ehMapa(valor) && !sentinela(valor) && ehMapa(alvo[chave])) {
      mesclar(alvo[chave], valor);
    } else {
      alvo[chave] = resolverValor(valor);
    }
  });
  return alvo;
}

function lerCampo(dados, caminho) {
  return caminho.split('.').reduce((atual, parte) => (atual == null ? undefined : atual[parte]), dados);
}

class Snapshot {
  constructor(ref, dados) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = dados !== undefined;
    this.dados = dados;
  }

  data() {
    return copiar(this.dados);
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }

  forEach(fn) {
    this.docs.forEach(fn);
  }
}

class Query {
  constructor(banco, filtroDeCaminho, filtros = [], limite = null, ordem = null, depoisDe = null) {
    this.banco = banco;
    this.filtroDeCaminho = filtroDeCaminho;
    this.filtros = filtros;
    this.limite = limite;
    this.ordem = ordem;
    this.depoisDe = depoisDe;
  }

  copia(mudancas) {
    const { filtros, limite, ordem, depoisDe } = { ...this, ...mudancas };
    return new Query(this.banco, this.filtroDeCaminho, filtros, limite, ordem, depoisDe);
  }

  where(campo, operador, valor) {
    return this.copia({ filtros: [...this.filtros, { campo, operador, valor }] });
  }

  orderBy(campo, direcao = 'asc') {
    return this.copia({ ordem: { campo, direcao } });
  }

  startAfter(snapshot) {
    return this.copia({ depoisDe: snapshot.ref.path });
  }

  select() {
    return this;
  }

  limit(limite) {
    return this.copia({ limite });
  }

  documentos() {
    let lista = [...this.banco.docs.entries()]
      .filter(([caminho]) => this.filtroDeCaminho(caminho))
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, dados]) => this.filtros.every(({ campo, operador, valor }) => {
        const atual = lerCampo(dados, campo);
        if (operador === '==') return atual === valor;
        if (operador === 'array-contains') return Array.isArray(atual) && atual.includes(valor);
        throw new Error(`operador nao suportado: ${operador}`);
      }))
      .map(([caminho, dados]) => new Snapshot(this.banco.doc(caminho), copiar(dados)));
    if (this.ordem) {
      // Como o Firestore: documento sem o campo fica de fora; empate, pelo caminho.
      const valor = (snapshot) => { const v = lerCampo(snapshot.dados, this.ordem.campo); return v instanceof Date ? v.getTime() : v; };
      const sinal = this.ordem.direcao === 'desc' ? -1 : 1;
      lista = lista.filter((snapshot) => valor(snapshot) !== undefined && valor(snapshot) !== null)
        .sort((a, b) => (valor(a) < valor(b) ? -sinal : valor(a) > valor(b) ? sinal : a.ref.path.localeCompare(b.ref.path)));
    }
    if (this.depoisDe) {
      const posicao = lista.findIndex((snapshot) => snapshot.ref.path === this.depoisDe);
      lista = lista.slice(posicao + 1);
    }
    if (this.limite !== null) lista = lista.slice(0, this.limite);
    return lista;
  }

  async get() {
    this.banco.leituras += 1;
    return new QuerySnapshot(this.documentos());
  }

  count() {
    return { get: async () => ({ data: () => ({ count: this.documentos().length }) }) };
  }
}

class CollectionRef extends Query {
  constructor(banco, caminho) {
    const profundidade = caminho.split('/').length + 1;
    super(banco, (doc) => doc.startsWith(`${caminho}/`) && doc.split('/').length === profundidade);
    this.caminho = caminho;
    this.path = caminho;
    this.id = caminho.split('/').at(-1);
    const partes = caminho.split('/');
    this.parent = partes.length > 1 ? banco.doc(partes.slice(0, -1).join('/')) : null;
  }

  doc(id) {
    const finalId = id ?? `auto_${(this.banco.proximoId += 1)}`;
    return this.banco.doc(`${this.caminho}/${finalId}`);
  }

  async add(dados) {
    const ref = this.doc();
    await ref.set(dados);
    return ref;
  }
}

class DocRef {
  constructor(banco, caminho) {
    this.banco = banco;
    this.path = caminho;
    this.id = caminho.split('/').at(-1);
  }

  get parent() {
    return new CollectionRef(this.banco, this.path.split('/').slice(0, -1).join('/'));
  }

  collection(nome) {
    return new CollectionRef(this.banco, `${this.path}/${nome}`);
  }

  async get() {
    this.banco.leituras += 1;
    return new Snapshot(this, copiar(this.banco.docs.get(this.path)));
  }

  async create(dados) {
    this.banco.aplicar([{ tipo: 'create', ref: this, dados }]);
  }

  async set(dados, opcoes = {}) {
    this.banco.aplicar([{ tipo: 'set', ref: this, dados, opcoes }]);
  }

  async update(dados) {
    this.banco.aplicar([{ tipo: 'update', ref: this, dados }]);
  }

  async delete() {
    this.banco.aplicar([{ tipo: 'delete', ref: this }]);
  }
}

class Batch {
  constructor(banco) {
    this.banco = banco;
    this.operacoes = [];
  }

  create(ref, dados) { this.operacoes.push({ tipo: 'create', ref, dados }); return this; }

  set(ref, dados, opcoes = {}) { this.operacoes.push({ tipo: 'set', ref, dados, opcoes }); return this; }

  update(ref, dados) { this.operacoes.push({ tipo: 'update', ref, dados }); return this; }

  delete(ref) { this.operacoes.push({ tipo: 'delete', ref }); return this; }

  async commit() {
    this.banco.aplicar(this.operacoes);
  }
}

export class FirestoreEmMemoria {
  constructor(dados = {}) {
    this.docs = new Map(Object.entries(dados).map(([caminho, valor]) => [caminho, copiar(valor)]));
    this.escritas = [];
    this.leituras = 0;
    this.proximoId = 0;
  }

  collection(caminho) {
    return new CollectionRef(this, caminho);
  }

  doc(caminho) {
    return new DocRef(this, caminho);
  }

  collectionGroup(id) {
    return new Query(this, (caminho) => caminho.split('/').at(-2) === id);
  }

  batch() {
    return new Batch(this);
  }

  async getAll(...refs) {
    return Promise.all(refs.map((ref) => ref.get()));
  }

  // Lote atomico: confere tudo antes de gravar qualquer coisa.
  aplicar(operacoes) {
    operacoes.forEach(({ tipo, ref }) => {
      const existe = this.docs.has(ref.path);
      if (tipo === 'create' && existe) throw Object.assign(new Error('6 ALREADY_EXISTS: Document already exists'), { code: 6 });
      if (tipo === 'update' && !existe) throw Object.assign(new Error('5 NOT_FOUND: No document to update'), { code: 5 });
    });
    operacoes.forEach(({ tipo, ref, dados, opcoes }) => {
      this.escritas.push({ tipo, caminho: ref.path, dados });
      if (tipo === 'delete') {
        this.docs.delete(ref.path);
      } else if (tipo === 'update') {
        const atual = this.docs.get(ref.path);
        Object.entries(dados).forEach(([caminho, valor]) => aplicarCampo(atual, caminho, valor));
      } else if (tipo === 'set' && opcoes?.merge) {
        this.docs.set(ref.path, mesclar(this.docs.get(ref.path) || {}, dados));
      } else {
        this.docs.set(ref.path, mesclar({}, dados));
      }
    });
  }

  dados(caminho) {
    return copiar(this.docs.get(caminho));
  }
}
