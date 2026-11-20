import { AppError } from '../../domain/errors/AppError.js';

// Aba "Alertas" do Admin (cola do Thay B57-03, D1 e D2, e B57-03c, item 8), pelo checklist de
// funcionamento de 18/11 (mockups-b57-03/checklist-funcionamento.md).
//
// - Conferencias automaticas: nesta rodada, so os itens 3, 6 e 14 do checklist (B57-03c, item 8).
//   Cada uma so le; quando falha, abre o alerta (ou atualiza o que ja esta aberto) e, quando volta
//   ao normal, fecha sozinha o alerta aberto. Nenhuma desliga, religa ou muda nada fora daqui.
// - Os outros itens, inclusive os de "Alerta no Admin: sim" que ainda nao tem conferencia
//   automatica (1, 5, 8, 9, 10 e 11), ficam em "Conferidos por alguem da equipe", com "Conferi
//   agora", que grava quem e quando.
//
// Grava so nas colecoes desta aba: alertasDoAdmin/{id} e conferenciasDoAdmin/{chave}.

export const COLECAO_DE_ALERTAS = 'alertasDoAdmin';
export const COLECAO_DE_CONFERENCIAS = 'conferenciasDoAdmin';

// Sem agenda publicada (function agendada ou Cloud Scheduler, so com o ok do Thay), as conferencias
// rodam quando a aba abre, no maximo uma vez a cada 10 minutos, e no "Conferir agora".
export const INTERVALO_ENTRE_CONFERENCIAS_MS = 10 * 60 * 1000;

// Itens do checklist (nome e onde, como o mockup aprovado e o checklist de 18/11).
export const ITENS_DO_CHECKLIST = Object.freeze([
  { item: 1, chave: 'entradas', nome: 'Entradas ligadas (SMS, Google, Apple e anônima)', onde: 'Firebase, Authentication' },
  { item: 2, chave: 'regioes-do-sms', nome: 'Regra de regiões do SMS inclui o Brasil', onde: 'Firebase, Authentication, Configurações' },
  { item: 3, chave: 'logins', nome: 'Tentativas de login que falharam', onde: 'Registro de tentativas', automatica: true },
  { item: 4, chave: 'sha-android', nome: 'Impressões SHA do Android no Firebase', onde: 'Firebase, App Android' },
  { item: 5, chave: 'functions', nome: 'Functions de pagamento, pedidos e avisos', onde: 'Google Cloud, Logs' },
  { item: 6, chave: 'safrapay', nome: 'Pagamento SafraPay do começo ao fim', onde: 'Pedidos do app', automatica: true },
  { item: 7, chave: 'segredos', nome: 'Segredos das Functions presentes', onde: 'Google Cloud, Secret Manager' },
  { item: 8, chave: 'avisos', nome: 'Avisos (push) chegando no Android e no iPhone', onde: 'Pedido de teste' },
  { item: 9, chave: 'faturamento', nome: 'Plano pago do Firebase e cartão da conta', onde: 'Google Cloud, Faturamento' },
  { item: 10, chave: 'sms', nome: 'Cota e gasto do SMS', onde: 'Firebase, Uso' },
  { item: 11, chave: 'maps', nome: 'Chave do Google Maps e Places', onde: 'Google Cloud, APIs' },
  { item: 12, chave: 'regras', nome: 'Versão das regras do banco no ar', onde: 'Firebase, Firestore, Regras' },
  { item: 13, chave: 'remote-config', nome: 'Remote Config com os valores esperados', onde: 'Firebase, Remote Config' },
  { item: 14, chave: 'sites', nome: 'Sites no ar (Gerenciador web, site e Admin)', onde: 'Verificação de disponibilidade', automatica: true },
  { item: 15, chave: 'emails', nome: 'E-mails de confirmação chegando', onde: 'Cadastro de teste' },
  { item: 16, chave: 'whatsapp', nome: 'Link do WhatsApp da Móbile', onde: 'Botão "Falar com a Móbile"' },
  { item: 17, chave: 'dominios', nome: 'Domínios renovados', onde: 'Registro.br' },
  { item: 18, chave: 'apple', nome: 'Assinatura do Apple Developer', onde: 'developer.apple.com' },
  { item: 19, chave: 'certificados-apple', nome: 'Certificados e chaves da Apple', onde: 'developer.apple.com, Certificados' },
  { item: 20, chave: 'google-play', nome: 'Conta de desenvolvedor da Google Play', onde: 'Play Console' },
]);

const LISTAS = new Set(['abertos', 'resolvidos', 'todos']);

function paraIso(valor) {
  if (!valor) return null;
  const data = typeof valor.toDate === 'function' ? valor.toDate() : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

function nomeDoAtor(ator) {
  return ator?.nome || ator?.email || null;
}

// Alerta como a aba mostra.
function linhaDoAlerta(snapshot) {
  const dados = snapshot.data() || {};
  return {
    id: snapshot.id,
    item: dados.item,
    chave: dados.chave,
    titulo: dados.titulo || '',
    texto: dados.texto || '',
    alcance: dados.alcance || { tipo: 'todas' },
    gravidade: dados.gravidade === 'atencao' ? 'atencao' : 'grave',
    detalhes: Array.isArray(dados.detalhes) ? dados.detalhes : [],
    situacao: dados.situacao === 'resolvido' ? 'resolvido' : 'aberto',
    abertoEm: paraIso(dados.abertoEm),
    resolvidoEm: paraIso(dados.resolvidoEm),
    resolvidoPor: dados.resolvidoPor || null,
  };
}

export class AlertasDoAdmin {
  // conferencias: { [chave]: async ({ agora }) => ({ ok: true } | { ok: false, alertas: [...] }) }
  // Cada alerta: { alcance, titulo, texto, gravidade, detalhes }.
  constructor({ firestore, conferencias = {}, clock = () => Date.now() }) {
    this.firestore = firestore;
    this.conferencias = conferencias;
    this.clock = clock;
  }

  get alertas() {
    return this.firestore.collection(COLECAO_DE_ALERTAS);
  }

  get registros() {
    return this.firestore.collection(COLECAO_DE_CONFERENCIAS);
  }

  // Abertos, resolvidos ou todos, do mais novo para o mais antigo, e a quantidade de abertos para o
  // numero vermelho do menu.
  async listar(lista = 'abertos') {
    if (!LISTAS.has(lista)) throw new AppError('Lista invalida.', { statusCode: 400, code: 'lista_invalida' });
    const todos = (await this.alertas.get()).docs.map(linhaDoAlerta);
    const abertos = todos.filter((alerta) => alerta.situacao === 'aberto').length;
    const escolhidos = todos
      .filter((alerta) => lista === 'todos' || (lista === 'abertos') === (alerta.situacao === 'aberto'))
      .sort((a, b) => String(b.abertoEm || '').localeCompare(String(a.abertoEm || '')));
    return { abertos, alertas: escolhidos };
  }

  async quantidadeDeAbertos() {
    return (await this.alertas.where('situacao', '==', 'aberto').get()).docs.length;
  }

  // As conferencias, em dois grupos, com a situacao e a hora da ultima.
  async listaDeConferencias() {
    const registros = new Map((await this.registros.get()).docs.map((doc) => [doc.id, doc.data() || {}]));
    const abertos = (await this.alertas.where('situacao', '==', 'aberto').get()).docs.map(linhaDoAlerta);
    const linha = (item) => {
      const registro = registros.get(item.chave) || {};
      return { item: item.item, chave: item.chave, nome: item.nome, onde: item.onde, registro };
    };
    const sozinhos = ITENS_DO_CHECKLIST.filter((item) => item.automatica && this.conferencias[item.chave]).map((item) => {
      const { registro, ...resto } = linha(item);
      const comAlerta = abertos.some((alerta) => alerta.chave === item.chave);
      return {
        ...resto,
        situacao: registro.ultimaEm ? (comAlerta ? 'alerta' : 'ok') : null,
        ultimaEm: paraIso(registro.ultimaEm),
      };
    });
    const daEquipe = ITENS_DO_CHECKLIST.filter((item) => !sozinhos.some((auto) => auto.chave === item.chave)).map((item) => {
      const { registro, ...resto } = linha(item);
      return { ...resto, conferidoEm: paraIso(registro.conferidoEm), conferidoPor: nomeDoAtor(registro.conferidoPor) };
    });
    return { sozinhos, daEquipe };
  }

  // "Conferi agora" num item conferido por alguem da equipe: grava quem e quando.
  async conferiAgora(chave, ator) {
    if (!ITENS_DO_CHECKLIST.some((item) => item.chave === chave) || this.conferencias[chave]) {
      throw new AppError('Item nao encontrado.', { statusCode: 404, code: 'item_nao_encontrado' });
    }
    const conferidoEm = new Date(this.clock());
    await this.registros.doc(chave).set({ chave, conferidoEm, conferidoPor: { uid: ator?.uid || null, email: ator?.email || null, nome: ator?.nome || null } }, { merge: true });
    return { chave, conferidoEm: conferidoEm.toISOString(), conferidoPor: nomeDoAtor(ator) };
  }

  // "Marcar como resolvido": grava quem e quando. Se o problema continuar, a proxima conferencia
  // abre um alerta novo.
  async resolver(id, ator) {
    const ref = this.alertas.doc(String(id || ''));
    const atual = await ref.get();
    if (!atual.exists) throw new AppError('Alerta nao encontrado.', { statusCode: 404, code: 'alerta_nao_encontrado' });
    if ((atual.data() || {}).situacao === 'resolvido') return linhaDoAlerta(await ref.get());
    await ref.set({
      situacao: 'resolvido',
      resolvidoEm: new Date(this.clock()),
      resolvidoPor: nomeDoAtor(ator),
    }, { merge: true });
    return linhaDoAlerta(await ref.get());
  }

  // Roda as conferencias automaticas. Sem `forcar`, so as que passaram do intervalo.
  async conferir({ forcar = false } = {}) {
    const agora = new Date(this.clock());
    const feitas = [];
    for (const [chave, conferencia] of Object.entries(this.conferencias)) {
      const item = ITENS_DO_CHECKLIST.find((linha) => linha.chave === chave);
      if (!item) continue;
      const registroRef = this.registros.doc(chave);
      if (!forcar) {
        const anterior = (await registroRef.get()).data() || {};
        const ultima = anterior.ultimaEm ? new Date(paraIso(anterior.ultimaEm)).getTime() : 0;
        if (agora.getTime() - ultima < INTERVALO_ENTRE_CONFERENCIAS_MS) continue;
      }
      let resultado;
      try {
        resultado = await conferencia({ agora });
      } catch (erro) {
        // A propria conferencia nao conseguiu ler: nao abre nem fecha alerta; fica registrado.
        await registroRef.set({ chave, item: item.item, ultimaEm: agora, falhouAoConferir: String(erro?.code || erro?.message || 'erro').slice(0, 120) }, { merge: true });
        feitas.push({ chave, ok: null });
        continue;
      }
      await this.aplicar(item, resultado, agora);
      await registroRef.set({ chave, item: item.item, ultimaEm: agora, falhouAoConferir: null }, { merge: true });
      feitas.push({ chave, ok: resultado.ok });
    }
    return { conferidas: feitas };
  }

  // Abre ou atualiza um alerta por alcance; fecha sozinhos os abertos que voltaram ao normal.
  async aplicar(item, resultado, agora) {
    const abertos = (await this.alertas.where('chave', '==', item.chave).get()).docs
      .filter((doc) => (doc.data() || {}).situacao === 'aberto');
    const chaveDoAlcance = (alcance) => (alcance?.tipo === 'loja' ? `loja:${alcance.lojaId}` : 'todas');
    const novos = resultado.ok ? [] : resultado.alertas || [];
    const continuam = new Set(novos.map((alerta) => chaveDoAlcance(alerta.alcance)));

    for (const doc of abertos) {
      if (!continuam.has(chaveDoAlcance((doc.data() || {}).alcance))) {
        await doc.ref.set({ situacao: 'resolvido', resolvidoEm: agora, resolvidoPor: 'sozinho' }, { merge: true });
      }
    }
    for (const alerta of novos) {
      const alcance = alerta.alcance || { tipo: 'todas' };
      const existente = abertos.find((doc) => chaveDoAlcance((doc.data() || {}).alcance) === chaveDoAlcance(alcance));
      const dados = {
        item: item.item,
        chave: item.chave,
        titulo: alerta.titulo,
        texto: alerta.texto,
        gravidade: alerta.gravidade === 'atencao' ? 'atencao' : 'grave',
        alcance,
        detalhes: (alerta.detalhes || []).slice(0, 20),
        atualizadoEm: agora,
      };
      if (existente) await existente.ref.set(dados, { merge: true });
      else await this.alertas.doc().set({ ...dados, situacao: 'aberto', abertoEm: agora, resolvidoEm: null, resolvidoPor: null });
    }
  }
}
