import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { autorDaAcao } from '../../domain/logs/autorDaAcao.js';
import {
  COLECAO_DOS_MOTIVOS, TAMANHO_DO_TEXTO, chaveDoTexto, ehPadrao, filtrarPorTipo, limparTexto, montarLista,
  motivoParaResposta,
} from '../../domain/loja/motivosDaSeparacao.js';

// Motivos da separacao da loja (cola do Thay B57-16 e B57-16b, item 11; contrato B57-16b-contrato-motivos.md).
// So o Core le e grava estabelecimentos/{loja}/MotivosDaSeparacao. Criar, editar e apagar (web) e o motivo
// novo salvo pelo App Gerenciador entram no Log da equipe, com o autor (e o computador) e a origem da tela.

const recusa = (mensagem, code, statusCode = 400) => new AppError(mensagem, { statusCode, code });

function textoValido(texto) {
  const limpo = limparTexto(texto);
  if (!limpo) throw recusa('Escreva o motivo.', 'motivo_sem_texto');
  if (limpo.length > TAMANHO_DO_TEXTO) throw recusa(`O motivo pode ter até ${TAMANHO_DO_TEXTO} caracteres.`, 'motivo_longo');
  return limpo;
}

const nomeDaConta = (conta) => conta?.userDocument?.nome || conta?.userDocument?.name || conta?.userDocument?.email || null;

export class MotivosDaSeparacao {
  constructor({ firestore, serverTimestamp = () => FieldValue.serverTimestamp(), increment = (n) => FieldValue.increment(n) }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
    this.increment = increment;
  }

  colecao(lojaId) {
    return this.firestore.collection('estabelecimentos').doc(String(lojaId || '')).collection(COLECAO_DOS_MOTIVOS);
  }

  async documentos(lojaId) {
    const snapshot = await this.colecao(lojaId).get();
    return snapshot.docs.map((documento) => ({ id: documento.id, dados: documento.data() || {} }));
  }

  async listar({ lojaId, tipo = 'todos' }) {
    return filtrarPorTipo(montarLista(await this.documentos(lojaId)), tipo);
  }

  async lerMotivo(lojaId, id) {
    const motivo = (await this.listar({ lojaId })).find((item) => item.id === id);
    return motivo || null;
  }

  async registrar({ lojaId, conta, computador = null, origemDaAcao = null, acao, motivoId, rotulo, antes = null, depois = null }) {
    const autor = autorDaAcao(conta, computador);
    await this.firestore.collection('estabelecimentos').doc(lojaId).collection('AcoesEquipe').doc().set({
      em: this.serverTimestamp(),
      quem: conta?.userDocument?.email || conta?.uid || '',
      tela: origemDaAcao?.tipo === 'app' ? 'separacao' : 'ajustes',
      acao,
      alvo: { tipo: 'motivoDaSeparacao', id: motivoId, rotulo },
      antes: antes && Object.keys(antes).length ? antes : null,
      depois: depois && Object.keys(depois).length ? depois : null,
      origem: origemDaAcao?.tipo === 'app' ? 'app' : 'manual',
      ...(autor ? { autor } : {}),
      ...(origemDaAcao ? { origemDaAcao } : {}),
    });
  }

  async criar({ lojaId, conta, computador, origemDaAcao, texto, troca, remocao, origem = 'web', usos = 0 }) {
    const limpo = textoValido(texto);
    if (!troca && !remocao) throw recusa('Ligue Troca, Remoção ou os dois.', 'motivo_sem_uso');
    const lista = await this.listar({ lojaId });
    if (lista.some((motivo) => chaveDoTexto(motivo.texto) === chaveDoTexto(limpo))) {
      throw recusa('Este motivo já existe.', 'motivo_repetido', 409);
    }
    const ref = this.colecao(lojaId).doc();
    const dados = {
      texto: limpo,
      troca: troca === true,
      remocao: remocao === true,
      origem,
      salvoPor: { id: conta?.uid || null, nome: nomeDaConta(conta) },
      salvoEm: this.serverTimestamp(),
      usos,
    };
    await ref.set(dados);
    await this.registrar({
      lojaId, conta, computador, origemDaAcao, acao: 'motivo.criar', motivoId: ref.id, rotulo: limpo,
      depois: { texto: limpo, troca: dados.troca, remocao: dados.remocao },
    });
    return this.lerMotivo(lojaId, ref.id);
  }

  async editar({ lojaId, conta, computador, origemDaAcao, id, campos = {} }) {
    const atual = await this.lerMotivo(lojaId, id);
    if (!atual) throw recusa('Motivo não encontrado.', 'motivo_nao_encontrado', 404);
    const mudancas = {};
    if (campos.texto !== undefined) {
      const limpo = textoValido(campos.texto);
      const lista = await this.listar({ lojaId });
      if (lista.some((motivo) => motivo.id !== id && chaveDoTexto(motivo.texto) === chaveDoTexto(limpo))) {
        throw recusa('Este motivo já existe.', 'motivo_repetido', 409);
      }
      if (limpo !== atual.texto) mudancas.texto = limpo;
    }
    ['troca', 'remocao'].forEach((campo) => {
      if (typeof campos[campo] === 'boolean' && campos[campo] !== atual[campo]) mudancas[campo] = campos[campo];
    });
    const troca = mudancas.troca ?? atual.troca;
    const remocao = mudancas.remocao ?? atual.remocao;
    if (!troca && !remocao) throw recusa('Ligue Troca, Remoção ou os dois.', 'motivo_sem_uso');
    if (!Object.keys(mudancas).length) return atual;
    await this.colecao(lojaId).doc(id).set({
      ...mudancas,
      ...(ehPadrao(id) ? { padrao: true } : {}),
      editadoPor: { id: conta?.uid || null, nome: nomeDaConta(conta) },
      editadoEm: this.serverTimestamp(),
    }, { merge: true });
    await this.registrar({
      lojaId, conta, computador, origemDaAcao, acao: 'motivo.editar', motivoId: id, rotulo: mudancas.texto || atual.texto,
      antes: Object.fromEntries(Object.keys(mudancas).map((campo) => [campo, atual[campo]])),
      depois: mudancas,
    });
    return this.lerMotivo(lojaId, id);
  }

  async apagar({ lojaId, conta, computador, origemDaAcao, id }) {
    const atual = await this.lerMotivo(lojaId, id);
    if (!atual) throw recusa('Motivo não encontrado.', 'motivo_nao_encontrado', 404);
    const ref = this.colecao(lojaId).doc(id);
    if (ehPadrao(id)) {
      await ref.set({ padrao: true, apagado: true, editadoPor: { id: conta?.uid || null, nome: nomeDaConta(conta) }, editadoEm: this.serverTimestamp() }, { merge: true });
    } else {
      await ref.delete();
    }
    await this.registrar({
      lojaId, conta, computador, origemDaAcao, acao: 'motivo.apagar', motivoId: id, rotulo: atual.texto,
      antes: { texto: atual.texto, troca: atual.troca, remocao: atual.remocao },
    });
    return { id, apagado: true };
  }

  // Ao concluir a separacao (App Gerenciador): texto de um motivo que ja existe soma o uso; texto novo com
  // "Salvar para usar mais vezes" vira um motivo da loja (origem 'app'); texto novo sem o check, nada.
  async usar({ lojaId, conta, computador, origemDaAcao, texto, salvar = false, tipos = [] }) {
    const limpo = textoValido(texto);
    const lista = await this.listar({ lojaId });
    const existente = lista.find((motivo) => chaveDoTexto(motivo.texto) === chaveDoTexto(limpo));
    if (existente) {
      await this.colecao(lojaId).doc(existente.id).set({
        usos: this.increment(1),
        ...(ehPadrao(existente.id) ? { padrao: true } : {}),
      }, { merge: true });
      return { motivo: await this.lerMotivo(lojaId, existente.id), criado: false };
    }
    if (!salvar) return { motivo: null, criado: false };
    const troca = tipos.includes('troca');
    const remocao = tipos.includes('remocao');
    if (!troca && !remocao) throw recusa('Diga se o motivo é de troca, de remoção ou dos dois.', 'motivo_sem_uso');
    const motivo = await this.criar({
      lojaId, conta, computador, origemDaAcao, texto: limpo.replace(/\.+$/, ''), troca, remocao, origem: 'app', usos: 1,
    });
    return { motivo, criado: true };
  }
}

export { motivoParaResposta };
