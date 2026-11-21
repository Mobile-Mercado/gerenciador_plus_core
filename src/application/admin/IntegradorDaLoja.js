import { createHash } from 'node:crypto';
import { AppError } from '../../domain/errors/AppError.js';

// Cola 65, item 4.11 ("Trocar o computador do integrador"): so o Admin da plataforma libera; a
// barreira (usersAdmin/{uid}.isAdmin) e o registro em adminAuditLogs ficam no /api/admin. O botao
// no Admin espera mockup.
function lojaValida(establishmentId) {
  const lojaId = typeof establishmentId === 'string' ? establishmentId.trim() : '';
  if (!lojaId || lojaId.length > 120 || lojaId.includes('/')) {
    throw new AppError('Loja inválida.', { statusCode: 400, code: 'loja_invalida' });
  }
  return lojaId;
}

// Timestamp do Firestore (ou Date) em ISO; outro valor, null.
function emIso(valor) {
  const data = typeof valor?.toDate === 'function' ? valor.toDate() : valor;
  return data instanceof Date && !Number.isNaN(data.getTime()) ? data.toISOString() : null;
}

function textoOuNull(valor, maximo = 100) {
  if (typeof valor !== 'string') return null;
  const texto = valor.trim();
  return texto ? texto.slice(0, maximo) : null;
}

// SHA-256 em hex minusculo do nome do computador, sem mudar maiusculas (contrato 4.11: o mesmo que o
// integrador 1.0.37 manda em x-integrador-maquina e que a nuvem calcula do machineName).
export function hashDoComputador(nome) {
  return createHash('sha256').update(nome, 'utf8').digest('hex');
}

// Cola 70, item 2: o nome vem de IntegrationStatus/current.machineName, em texto (so o Admin le).
// Com computador registrado, o nome so aparece se for dele (o hash confere): o sinal de vida pode
// ser de antes do registro ou de outro computador, e o card nao mostra um nome que nao e o registrado.
function nomeDoComputador(machineName, maquina) {
  if (typeof machineName !== 'string' || !machineName.trim()) return null;
  if (maquina && hashDoComputador(machineName) !== maquina) return null;
  return textoOuNull(machineName);
}

// Cola 70, item 3: ultima tentativa recusada (409), gravada pela nuvem em
// IntegradorDaLoja/atual.tentativaRecusada { maquina, nome, em }. Sai { nome, em } (o hash nao sai);
// nome null quando a chamada recusada nao trouxe o nome (so o sinal de vida traz). Sem tentativa
// gravada, com a troca liberada ou de outro computador que nao o recusado, null (a linha nao aparece).
function tentativaRecusada(registro, maquina) {
  const tentativa = registro?.tentativaRecusada;
  if (!maquina || registro?.trocaLiberadaEm || !tentativa) return null;
  const em = emIso(tentativa.em);
  if (!em || tentativa.maquina === maquina) return null;
  // A nuvem so grava o nome que confere com o hash.
  return { nome: textoOuNull(tentativa.nome), em };
}

export class IntegradorDaLoja {
  constructor({ repositorio }) {
    this.repositorio = repositorio;
  }

  // Cola 70, item 1: card "Computador do integrador" na loja aberta do Admin. Desde = registradoEm
  // do registro; Ultimo sinal = IntegrationStatus/current.lastSeenAt; versao no subtitulo =
  // IntegrationStatus/current.version. Loja sem registro ou sem sinal de vida: os campos vem null.
  // O hash do computador nunca sai daqui.
  async computador({ establishmentId }) {
    const lojaId = lojaValida(establishmentId);
    const { lojaExiste, registro, status } = await this.repositorio.lerComputador({ lojaId });
    if (!lojaExiste) {
      throw new AppError('Loja não encontrada.', { statusCode: 404, code: 'loja_nao_encontrada' });
    }
    const maquina = typeof registro?.maquina === 'string' && registro.maquina ? registro.maquina : null;
    return {
      establishmentId: lojaId,
      computador: nomeDoComputador(status?.machineName, maquina),
      registrado: Boolean(maquina),
      registradoEm: maquina ? emIso(registro.registradoEm) : null,
      trocaLiberadaEm: emIso(registro?.trocaLiberadaEm),
      ultimoSinalEm: emIso(status?.lastSeenAt),
      versao: textoOuNull(status?.version, 40),
      tentativaRecusada: tentativaRecusada(registro, maquina),
    };
  }

  async trocarComputador({ establishmentId, adminUid }) {
    const lojaId = lojaValida(establishmentId);
    if (!adminUid) {
      throw new AppError('Login obrigatorio para usar este recurso.', { statusCode: 401, code: 'auth_token_required' });
    }
    const { lojaExiste, computadorRegistrado } = await this.repositorio.liberarTroca({ lojaId, adminUid });
    if (!lojaExiste) {
      throw new AppError('Loja não encontrada.', { statusCode: 404, code: 'loja_nao_encontrada' });
    }
    return { establishmentId: lojaId, trocaLiberada: true, computadorRegistrado };
  }
}
