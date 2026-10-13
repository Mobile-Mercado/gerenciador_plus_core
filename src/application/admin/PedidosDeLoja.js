import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { STATUS } from '../cadastro/CadastroDeLoja.js';

// Estabelecimentos > Pedidos de loja (Admin, rodada de 13/10/2026). Lista os pedidos do cadastro
// pelo app gerenciador e decide: aprovar (status aprovada + claim adminOf do dono), recusar com
// motivo ou marcar "Em conversa". Aprovar nao liga a loja no app (isActive e manual, pelo botao
// do Admin). Os cadastros que pararam antes do e-mail confirmado ficam numa lista separada.
const ABERTOS = [STATUS.EM_ANALISE, STATUS.EM_CONVERSA];
const LISTAS = Object.freeze({
  abertos: ABERTOS,
  parados: [STATUS.AGUARDANDO_EMAIL],
  aprovados: [STATUS.APROVADA],
  recusados: [STATUS.RECUSADA],
});

export function quandoIso(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate().toISOString();
  if (valor instanceof Date) return valor.toISOString();
  return null;
}

function linhaDoPedido(documento) {
  const data = documento.data() || {};
  return {
    id: documento.id,
    nome: data.name || documento.id,
    cidade: data.address?.city || null,
    uf: data.address?.uf || data.address?.state || null,
    cnpj: data.cnpj || null,
    cnpjConferido: data.cnpjConferido === true,
    razaoSocial: data.razaoSocial || null,
    responsavel: { nome: data.responsibleName || null, celular: data.phone || null, email: data.email || null },
    status: data.status,
    criadoEm: quandoIso(data.createdAt),
    enviadoEm: quandoIso(data.enviadoEm),
    aprovadoEm: quandoIso(data.aprovadoEm),
    recusadoEm: quandoIso(data.recusadoEm),
    motivoRecusa: data.motivoRecusa || null,
    temLogo: Boolean(data.chatProfileImageUrl),
    temFachada: Boolean(data.coverImageUrl),
  };
}

export class PedidosDeLoja {
  constructor({ firestore, auth, serverTimestamp = () => FieldValue.serverTimestamp() }) {
    this.firestore = firestore;
    this.auth = auth;
    this.serverTimestamp = serverTimestamp;
  }

  async listar(lista = 'abertos') {
    const status = LISTAS[lista];
    if (!status) throw new AppError('Lista inválida.', { statusCode: 400, code: 'pedidos_lista_invalida' });
    const resultados = await Promise.all(status.map((valor) => this.firestore
      .collection('estabelecimentos').where('status', '==', valor).get()));
    return resultados.flatMap((resultado) => resultado.docs.map(linhaDoPedido))
      .sort((a, b) => String(b.enviadoEm || b.criadoEm || '').localeCompare(String(a.enviadoEm || a.criadoEm || '')));
  }

  async pedido(lojaId) {
    const loja = await this.firestore.collection('estabelecimentos').doc(String(lojaId || '')).get();
    if (!loja.exists || !loja.data()?.status) {
      throw new AppError('Pedido de loja não encontrado.', { statusCode: 404, code: 'pedido_nao_encontrado' });
    }
    return loja;
  }

  // Dono do pedido: a conta do Users apontado em userReference.
  async donoDoPedido(loja) {
    const referencia = loja.data()?.userReference;
    const usuario = referencia ? await referencia.get() : null;
    const uid = usuario?.exists ? usuario.data()?.userAuthId : null;
    if (!uid) {
      throw new AppError('Este pedido não tem conta de dono ligada.', { statusCode: 409, code: 'pedido_sem_dono' });
    }
    return uid;
  }

  assertAberto(loja) {
    if (!ABERTOS.includes(loja.data()?.status)) {
      throw new AppError('Só pedido em análise ou em conversa pode ser decidido.', {
        statusCode: 409,
        code: 'pedido_nao_esta_aberto',
        details: { status: loja.data()?.status || null },
      });
    }
  }

  // Aprovar: status aprovada, quem e quando, e a claim adminOf do dono com o id da loja (as
  // outras claims da conta ficam). O Core acha a loja pela claim e por userReference.
  async aprovar(lojaId, ator = {}) {
    const loja = await this.pedido(lojaId);
    this.assertAberto(loja);
    const uid = await this.donoDoPedido(loja);
    const conta = await this.auth.getUser(uid);
    const claimsAntigas = { ...(conta.customClaims || {}) };
    const claimsNovas = { ...claimsAntigas, adminOf: loja.id };
    delete claimsNovas.groupId;
    await this.auth.setCustomUserClaims(uid, claimsNovas);
    await loja.ref.update({
      status: STATUS.APROVADA,
      aprovadoPor: ator.uid || null,
      aprovadoEm: this.serverTimestamp(),
      updatedAt: this.serverTimestamp(),
    });
    return { ...linhaDoPedido(await loja.ref.get()), uidDono: uid, claimsAntigas, claimsNovas };
  }

  async recusar(lojaId, motivo, ator = {}) {
    const texto = String(motivo || '').trim();
    if (texto.length < 3) {
      throw new AppError('Escreva o motivo da recusa.', { statusCode: 400, code: 'pedido_motivo_obrigatorio' });
    }
    const loja = await this.pedido(lojaId);
    this.assertAberto(loja);
    await loja.ref.update({
      status: STATUS.RECUSADA,
      motivoRecusa: texto.slice(0, 500),
      recusadoPor: ator.uid || null,
      recusadoEm: this.serverTimestamp(),
      updatedAt: this.serverTimestamp(),
    });
    return linhaDoPedido(await loja.ref.get());
  }

  // "Em conversa": marcada e desmarcada pela equipe; desmarcar volta para em analise.
  async marcarEmConversa(lojaId, emConversa) {
    const loja = await this.pedido(lojaId);
    this.assertAberto(loja);
    await loja.ref.update({
      status: emConversa ? STATUS.EM_CONVERSA : STATUS.EM_ANALISE,
      updatedAt: this.serverTimestamp(),
    });
    return linhaDoPedido(await loja.ref.get());
  }
}
