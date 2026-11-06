import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { COLECAO_PEDIDOS, STATUS } from '../cadastro/CadastroDeLoja.js';

// Estabelecimentos > Pedidos de loja (Admin). Lista os pedidos do cadastro pelo app gerenciador,
// em pedidosDeLoja/{id}, e decide: aprovar, recusar com motivo ou marcar "Em conversa".
// Desde 17/10/2026 (decisao do Thay) o pedido nao cria loja: a loja nasce aqui, no "Aprovar",
// com os dados do pedido, no mesmo formato que o cadastro gravava, ligada ao dono por
// userReference e desligada (isActive e manual, pelo botao do Admin). "Recusar" grava o motivo
// no pedido e nao cria loja. Os cadastros que pararam antes do e-mail confirmado ficam numa lista
// separada. Os cadastros incompletos do app (rascunhos da jornada, que nao viraram pedido) vem nas
// listas "incompletos" (em andamento e em conversa) e "descartados", com as marcas do Admin.
const ABERTOS = [STATUS.EM_ANALISE, STATUS.EM_CONVERSA];
const LISTAS = Object.freeze({
  abertos: ABERTOS,
  parados: [STATUS.AGUARDANDO_EMAIL],
  aprovados: [STATUS.APROVADA],
  recusados: [STATUS.RECUSADA],
});
export const LISTAS_DA_JORNADA = Object.freeze(['incompletos', 'descartados']);

// Campos do pedido que viram a loja no "Aprovar" (o que o cadastro gravava em estabelecimentos).
const CAMPOS_DA_LOJA = Object.freeze([
  'name', 'razaoSocial', 'corporateName', 'nomeFantasia', 'cnpj', 'cpfOrCnpj', 'cnpjConferido', 'cnpjAtivo',
  'cnpjSituacao', 'cnpjRepetido', 'lojasComOMesmoCnpj', 'enderecoReceita', 'address', 'erp', 'instalacaoId', 'phone',
  'email', 'responsibleName', 'origemCadastro', 'userReference', 'enviadoEm',
]);

export function quandoIso(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate().toISOString();
  if (valor instanceof Date) return valor.toISOString();
  return null;
}

function linhaDoPedido(documento) {
  const data = documento.data() || {};
  return {
    tipo: 'pedido',
    id: documento.id,
    pedidoId: documento.id,
    lojaId: data.lojaId || null,
    nome: data.name || documento.id,
    cidade: data.address?.city || null,
    uf: data.address?.uf || data.address?.state || null,
    cnpj: data.cnpj || null,
    cnpjConferido: data.cnpjConferido === true,
    cnpjAtivo: data.cnpjAtivo ?? null,
    cnpjRepetido: data.cnpjRepetido === true,
    cidadeReceita: data.enderecoReceita?.city || null,
    erp: data.erp || null,
    instalacaoId: data.instalacaoId || null,
    razaoSocial: data.razaoSocial || null,
    responsavel: { nome: data.responsibleName || null, celular: data.phone || null, email: data.email || null },
    status: data.status,
    criadoEm: quandoIso(data.createdAt),
    enviadoEm: quandoIso(data.enviadoEm),
    aprovadoEm: quandoIso(data.aprovadoEm),
    recusadoEm: quandoIso(data.recusadoEm),
    motivoRecusa: data.motivoRecusa || null,
  };
}

export class PedidosDeLoja {
  constructor({ firestore, auth, jornada = null, serverTimestamp = () => FieldValue.serverTimestamp() }) {
    this.firestore = firestore;
    this.auth = auth;
    this.jornada = jornada;
    this.serverTimestamp = serverTimestamp;
  }

  async listar(lista = 'abertos') {
    if (LISTAS_DA_JORNADA.includes(lista)) {
      if (!this.jornada) throw new AppError('Lista inválida.', { statusCode: 400, code: 'pedidos_lista_invalida' });
      return this.jornada.listarIncompletos(lista);
    }
    const status = LISTAS[lista];
    if (!status) throw new AppError('Lista inválida.', { statusCode: 400, code: 'pedidos_lista_invalida' });
    const resultados = await Promise.all(status.map((valor) => this.firestore
      .collection(COLECAO_PEDIDOS).where('status', '==', valor).get()));
    return resultados.flatMap((resultado) => resultado.docs.map(linhaDoPedido))
      .sort((a, b) => String(b.enviadoEm || b.criadoEm || '').localeCompare(String(a.enviadoEm || a.criadoEm || '')));
  }

  async pedido(pedidoId) {
    const pedido = await this.firestore.collection(COLECAO_PEDIDOS).doc(String(pedidoId || '')).get();
    if (!pedido.exists) {
      throw new AppError('Pedido de loja não encontrado.', { statusCode: 404, code: 'pedido_nao_encontrado' });
    }
    return pedido;
  }

  // Dono do pedido: a conta do Users apontado em userReference.
  async donoDoPedido(pedido) {
    const referencia = pedido.data()?.userReference;
    const usuario = referencia ? await referencia.get() : null;
    const uid = usuario?.exists ? usuario.data()?.userAuthId : null;
    if (!uid) {
      throw new AppError('Este pedido não tem conta de dono ligada.', { statusCode: 409, code: 'pedido_sem_dono' });
    }
    return uid;
  }

  assertAberto(pedido) {
    if (!ABERTOS.includes(pedido.data()?.status)) {
      throw new AppError('Só pedido em análise ou em conversa pode ser decidido.', {
        statusCode: 409,
        code: 'pedido_nao_esta_aberto',
        details: { status: pedido.data()?.status || null },
      });
    }
  }

  // Loja nascida do pedido: os dados do pedido no formato que o cadastro gravava, desligada.
  lojaDoPedido(pedido, lojaId, ator, agora) {
    const data = pedido.data() || {};
    const loja = Object.fromEntries(CAMPOS_DA_LOJA.filter((campo) => data[campo] !== undefined).map((campo) => [campo, data[campo]]));
    return {
      ...loja,
      id: lojaId,
      isActive: false,
      userType: 'UserType.noneEmpresa',
      status: STATUS.APROVADA,
      pedidoDeLojaId: pedido.id,
      aprovadoPor: ator.uid || null,
      aprovadoEm: agora,
      createdAt: agora,
      updatedAt: agora,
    };
  }

  // Aprovar: cria estabelecimentos/{novo} com os dados do pedido, grava o lojaId no pedido e da
  // ao dono a claim adminOf da loja nova (as outras claims da conta ficam). Se a gravacao falhar,
  // a claim antiga volta.
  async aprovar(pedidoId, ator = {}) {
    const pedido = await this.pedido(pedidoId);
    this.assertAberto(pedido);
    const uid = await this.donoDoPedido(pedido);
    const lojaRef = this.firestore.collection('estabelecimentos').doc();
    const conta = await this.auth.getUser(uid);
    const claimsAntigas = { ...(conta.customClaims || {}) };
    const claimsNovas = { ...claimsAntigas, adminOf: lojaRef.id };
    delete claimsNovas.groupId;
    await this.auth.setCustomUserClaims(uid, claimsNovas);
    const agora = this.serverTimestamp();
    try {
      const lote = this.firestore.batch();
      lote.create(lojaRef, this.lojaDoPedido(pedido, lojaRef.id, ator, agora));
      lote.update(pedido.ref, {
        status: STATUS.APROVADA,
        lojaId: lojaRef.id,
        aprovadoPor: ator.uid || null,
        aprovadoEm: agora,
        updatedAt: agora,
      });
      await lote.commit();
    } catch (error) {
      await this.auth.setCustomUserClaims(uid, claimsAntigas);
      throw error;
    }
    try {
      await this.jornada?.aprovada(pedido.data()?.instalacaoId, lojaRef.id);
    } catch {
      // O funil perde a marca da aprovacao; a loja e o pedido ficam.
    }
    return { ...linhaDoPedido(await pedido.ref.get()), uidDono: uid, claimsAntigas, claimsNovas };
  }

  async recusar(pedidoId, motivo, ator = {}) {
    const texto = String(motivo || '').trim();
    if (texto.length < 3) {
      throw new AppError('Escreva o motivo da recusa.', { statusCode: 400, code: 'pedido_motivo_obrigatorio' });
    }
    const pedido = await this.pedido(pedidoId);
    this.assertAberto(pedido);
    await pedido.ref.update({
      status: STATUS.RECUSADA,
      motivoRecusa: texto.slice(0, 500),
      recusadoPor: ator.uid || null,
      recusadoEm: this.serverTimestamp(),
      updatedAt: this.serverTimestamp(),
    });
    return linhaDoPedido(await pedido.ref.get());
  }

  // Cadastro incompleto (rascunho da jornada): "Em conversa", "Descartar" ou voltar para em
  // andamento. So marca; nada e apagado.
  async marcarIncompleto(instalacaoId, situacao, ator = {}) {
    if (!this.jornada) throw new AppError('Cadastro incompleto não encontrado.', { statusCode: 404, code: 'cadastro_incompleto_nao_encontrado' });
    return this.jornada.marcar(instalacaoId, situacao, ator);
  }

  // "Em conversa": marcada e desmarcada pela equipe; desmarcar volta para em analise.
  async marcarEmConversa(pedidoId, emConversa) {
    const pedido = await this.pedido(pedidoId);
    this.assertAberto(pedido);
    await pedido.ref.update({
      status: emConversa ? STATUS.EM_CONVERSA : STATUS.EM_ANALISE,
      updatedAt: this.serverTimestamp(),
    });
    return linhaDoPedido(await pedido.ref.get());
  }
}
