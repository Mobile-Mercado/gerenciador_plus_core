import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { lojaLiberada } from '../../domain/cadastro/lojaLiberada.js';
import {
  formatarCnpj, somenteDigitos, validarCnpj, validarNomeNoApp,
} from '../../domain/cadastro/validacoes.js';
import { quandoIso } from './PedidosDeLoja.js';

// Estabelecimentos > abrir uma loja (Admin, rodada de 13/10/2026): contas da loja e se cada
// uma entra no Gerenciador Plus, "Corrigir acesso", edicao com previa, ligar no app Mobile
// Supermercados (isActive, sempre manual), excluir so loja vazia, aparencia e agendamento.
const COR = /^#[0-9A-Fa-f]{6}$/;
export const OFFER_COLOR_PADRAO = '#FFF4D1';
const CAMPOS_EDITAVEIS = ['name', 'address', 'phone', 'cnpj'];
const CAMPOS_ENDERECO = ['street', 'number', 'complement', 'neighborhood', 'city', 'uf', 'zipCode'];

function naoEncontrada() {
  return new AppError('Loja não encontrada.', { statusCode: 404, code: 'loja_nao_encontrada' });
}

function texto(valor, maximo = 120) {
  const limpo = String(valor ?? '').replace(/\s+/g, ' ').trim();
  return limpo ? limpo.slice(0, maximo) : null;
}

export class LojaNoAdmin {
  constructor({
    firestore, auth, accessRepository, imagens = null, serverTimestamp = () => FieldValue.serverTimestamp(),
  }) {
    this.firestore = firestore;
    this.auth = auth;
    this.accessRepository = accessRepository;
    this.imagens = imagens;
    this.serverTimestamp = serverTimestamp;
  }

  async loja(lojaId) {
    const loja = await this.firestore.collection('estabelecimentos').doc(String(lojaId || '')).get();
    if (!loja.exists) throw naoEncontrada();
    return loja;
  }

  // ===== Contas da loja =====

  // Uids ligados a loja: o dono por userReference, quem tem Users.id = loja e os funcionarios
  // de AdminUsers. Para cada um, o papel e se a conta entra no Gerenciador Plus nesta loja.
  async contas(lojaId) {
    const loja = await this.loja(lojaId);
    const papeis = new Map();
    const referencia = loja.data()?.userReference;
    const [donoDoc, porId, funcionarios] = await Promise.all([
      referencia ? referencia.get() : null,
      this.firestore.collection('Users').where('id', '==', loja.id).get(),
      loja.ref.collection('AdminUsers').get(),
    ]);
    if (donoDoc?.exists && donoDoc.data()?.userAuthId) papeis.set(donoDoc.data().userAuthId, 'dono');
    porId.docs.forEach((documento) => {
      const uid = documento.data()?.userAuthId;
      if (uid && !papeis.has(uid)) papeis.set(uid, 'dono');
    });
    funcionarios.docs.forEach((documento) => {
      if (!papeis.has(documento.id) || papeis.get(documento.id) !== 'dono') papeis.set(documento.id, 'funcionario');
    });
    const contas = await Promise.all([...papeis.entries()].map(([uid, papel]) => this.conta(loja, uid, papel)));
    return contas.sort((a, b) => (a.papel === b.papel ? String(a.email).localeCompare(String(b.email)) : a.papel === 'dono' ? -1 : 1));
  }

  async conta(loja, uid, papel) {
    let registro = null;
    try {
      registro = await this.auth.getUser(uid);
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
    const claims = registro?.customClaims || {};
    const base = { uid, papel, email: registro?.email || null, claims };
    if (!registro) return { ...base, entra: false, motivo: 'A conta não existe mais no login.' };
    if (registro.disabled) return { ...base, entra: false, motivo: 'A conta está desativada no login.' };
    let resolvida = null;
    try {
      resolvida = await this.accessRepository.findAccountByClaims({ uid, adminOf: claims.adminOf, groupId: claims.groupId });
    } catch (error) {
      if (error?.code === 'admin_user_disabled') return { ...base, entra: false, motivo: 'O funcionário está desativado nesta loja.' };
      throw error;
    }
    if (!resolvida) return { ...base, entra: false, motivo: 'A conta não tem documento em Users nem acesso de funcionário.' };
    if (resolvida.establishmentId !== loja.id) {
      const outra = resolvida.hasEstablishment ? `a loja ${resolvida.establishmentId}` : `uma loja que não existe (${resolvida.establishmentId})`;
      return {
        ...base,
        entra: false,
        motivo: claims.adminOf && claims.adminOf !== loja.id
          ? `A claim adminOf aponta para ${outra}.`
          : `O painel acha ${outra} para esta conta.`,
      };
    }
    if (!lojaLiberada(resolvida.establishmentDocument)) {
      return { ...base, entra: false, motivo: 'A loja ainda não foi aprovada (pedido de loja).' };
    }
    return { ...base, entra: true, motivo: null };
  }

  // Corrigir acesso: a claim adminOf passa a ser a loja. groupId so fica se o grupo existe
  // nesta loja; sem ele, o dono entra com acesso total (no painel e no app gerenciador).
  async previaDoAcesso(lojaId, uid) {
    const loja = await this.loja(lojaId);
    const registro = await this.auth.getUser(uid);
    const claimsAntigas = { ...(registro.customClaims || {}) };
    const claimsNovas = { ...claimsAntigas, adminOf: loja.id };
    if (claimsNovas.groupId) {
      const grupo = await loja.ref.collection('PermissionGroups').doc(String(claimsNovas.groupId)).get();
      if (!grupo.exists) delete claimsNovas.groupId;
    }
    const antes = await this.conta(loja, uid, 'dono');
    return { uid, email: registro.email || null, claimsAntigas, claimsNovas, entraHoje: antes.entra, motivoHoje: antes.motivo };
  }

  async corrigirAcesso(lojaId, uid) {
    const previa = await this.previaDoAcesso(lojaId, uid);
    await this.auth.setCustomUserClaims(uid, previa.claimsNovas);
    const loja = await this.loja(lojaId);
    const depois = await this.conta(loja, uid, 'dono');
    return { ...previa, entraDepois: depois.entra, motivoDepois: depois.motivo };
  }

  // ===== Edicao com previa =====

  normalizarEdicao(entrada = {}) {
    const mudancas = {};
    if (entrada.name !== undefined) mudancas.name = validarNomeNoApp(entrada.name);
    if (entrada.phone !== undefined) {
      // Telefone da loja: fixo (10 digitos) ou celular (11), com DDD.
      const telefone = somenteDigitos(entrada.phone);
      if (telefone.length < 10 || telefone.length > 11) {
        throw new AppError('Telefone inválido. Use o DDD e o número.', { statusCode: 400, code: 'loja_telefone_invalido' });
      }
      mudancas.phone = telefone;
    }
    if (entrada.cnpj !== undefined) mudancas.cnpj = validarCnpj(entrada.cnpj);
    if (entrada.address !== undefined) {
      mudancas.address = Object.fromEntries(CAMPOS_ENDERECO.map((campo) => [campo, texto(entrada.address?.[campo])]));
      if (mudancas.address.uf) mudancas.address.uf = mudancas.address.uf.toUpperCase().slice(0, 2);
    }
    return mudancas;
  }

  async previaDaEdicao(lojaId, entrada) {
    const loja = await this.loja(lojaId);
    const atual = loja.data() || {};
    const mudancas = this.normalizarEdicao(entrada);
    const diferencas = CAMPOS_EDITAVEIS.filter((campo) => mudancas[campo] !== undefined)
      .map((campo) => {
        const antes = campo === 'address'
          ? Object.fromEntries(CAMPOS_ENDERECO.map((parte) => [parte, atual.address?.[parte] ?? (parte === 'uf' ? atual.address?.state : null) ?? null]))
          : (campo === 'cnpj' ? atual.cnpj || String(atual.cpfOrCnpj || '').replace(/\D/g, '') || null : atual[campo] ?? null);
        return { campo, antes, depois: mudancas[campo] };
      })
      .filter(({ antes, depois }) => JSON.stringify(antes) !== JSON.stringify(depois));
    if (mudancas.cnpj && diferencas.some(({ campo }) => campo === 'cnpj')) await this.assertCnpjDeOutraLoja(loja.id, mudancas.cnpj);
    return { lojaId: loja.id, diferencas };
  }

  async assertCnpjDeOutraLoja(lojaId, cnpj) {
    const lojas = this.firestore.collection('estabelecimentos');
    const consultas = await Promise.all([
      lojas.where('cnpj', '==', cnpj).limit(5).get(),
      lojas.where('cpfOrCnpj', '==', formatarCnpj(cnpj)).limit(5).get(),
    ]);
    if (consultas.some((resultado) => resultado.docs.some((documento) => documento.id !== lojaId))) {
      throw new AppError('Este CNPJ já está em outra loja.', { statusCode: 409, code: 'loja_cnpj_em_uso' });
    }
  }

  async editar(lojaId, entrada) {
    const { diferencas } = await this.previaDaEdicao(lojaId, entrada);
    if (!diferencas.length) return { lojaId, diferencas };
    const atualizacao = { updatedAt: this.serverTimestamp() };
    diferencas.forEach(({ campo, depois }) => {
      if (campo === 'address') {
        Object.entries(depois).forEach(([parte, valor]) => { atualizacao[`address.${parte}`] = valor; });
        atualizacao['address.state'] = depois.uf;
        atualizacao['address.fullAddress'] = [
          [depois.street, depois.number].filter(Boolean).join(', '), depois.neighborhood, [depois.city, depois.uf].filter(Boolean).join(' - '),
        ].filter(Boolean).join(', ') || null;
        atualizacao['address.updateAt'] = this.serverTimestamp();
      } else if (campo === 'cnpj') {
        atualizacao.cnpj = depois;
        atualizacao.cpfOrCnpj = formatarCnpj(depois);
      } else {
        atualizacao[campo] = depois;
      }
    });
    await this.firestore.collection('estabelecimentos').doc(lojaId).update(atualizacao);
    return { lojaId, diferencas };
  }

  // Ligar no app Mobile Supermercados: so pelo botao do Admin.
  async ativarNoApp(lojaId, ativa) {
    const loja = await this.loja(lojaId);
    await loja.ref.update({ isActive: ativa === true, updatedAt: this.serverTimestamp() });
    return { lojaId: loja.id, ativa: ativa === true, antes: loja.data()?.isActive !== false };
  }

  // ===== Excluir: so loja sem pedidos e sem produtos =====

  async previaDaExclusao(lojaId) {
    const loja = await this.loja(lojaId);
    const [produtos, pedidos, subcolecoes] = await Promise.all([
      loja.ref.collection('Products').count().get(),
      this.firestore.collection('PurchaseRequests').where('companyReference', '==', loja.ref).count().get(),
      typeof loja.ref.listCollections === 'function' ? loja.ref.listCollections() : [],
    ]);
    const contagens = await Promise.all(subcolecoes.map(async (colecao) => ({
      colecao: colecao.id,
      documentos: Number((await colecao.count().get()).data()?.count) || 0,
    })));
    const totalProdutos = Number(produtos.data()?.count) || 0;
    const totalPedidos = Number(pedidos.data()?.count) || 0;
    return {
      lojaId: loja.id,
      nome: loja.data()?.name || loja.data()?.nomeEstabelecimento || loja.id,
      produtos: totalProdutos,
      pedidos: totalPedidos,
      podeExcluir: totalProdutos === 0 && totalPedidos === 0,
      sai: [{ colecao: '(documento da loja)', documentos: 1 }, ...contagens],
    };
  }

  async excluir(lojaId, confirmacaoNome) {
    const previa = await this.previaDaExclusao(lojaId);
    if (!previa.podeExcluir) {
      throw new AppError('Loja com pedidos ou produtos não se exclui: desative.', { statusCode: 409, code: 'loja_com_pedidos_ou_produtos' });
    }
    if (String(confirmacaoNome || '').trim() !== String(previa.nome).trim()) {
      throw new AppError('Digite o nome da loja exatamente como aparece para confirmar.', { statusCode: 400, code: 'loja_confirmacao_nome' });
    }
    const loja = await this.loja(lojaId);
    const documento = loja.data();
    await this.firestore.recursiveDelete(loja.ref);
    return { ...previa, excluida: true, documento };
  }

  // ===== Aparencia (so campos que o app ja le, mais offerColor) =====

  async aparencia(lojaId) {
    const data = (await this.loja(lojaId)).data() || {};
    return {
      lojaId,
      primaryColor: data.primaryColor || null,
      secondaryColor: data.secondaryColor || null,
      offerColor: data.offerColor || null,
      offerColorPadrao: OFFER_COLOR_PADRAO,
      slogan: data.slogan || null,
      chatProfileImageUrl: data.chatProfileImageUrl || null,
      coverImageUrl: data.coverImageUrl || null,
      splashImageUrl: data.splashImageUrl || null,
      loadingImageUrl: data.loadingImageUrl || null,
    };
  }

  async salvarAparencia(lojaId, entrada = {}) {
    const loja = await this.loja(lojaId);
    const atualizacao = {};
    ['primaryColor', 'secondaryColor', 'offerColor'].forEach((campo) => {
      if (entrada[campo] === undefined) return;
      if (entrada[campo] === null || entrada[campo] === '') {
        atualizacao[campo] = FieldValue.delete();
        return;
      }
      if (!COR.test(String(entrada[campo]))) {
        throw new AppError('Use a cor no formato #RRGGBB.', { statusCode: 400, code: 'aparencia_cor_invalida', details: { campo } });
      }
      atualizacao[campo] = String(entrada[campo]).toUpperCase();
    });
    if (entrada.slogan !== undefined) atualizacao.slogan = texto(entrada.slogan, 80);
    if (!Object.keys(atualizacao).length) return this.aparencia(loja.id);
    await loja.ref.update({ ...atualizacao, updatedAt: this.serverTimestamp() });
    return this.aparencia(loja.id);
  }

  async trocarImagem(lojaId, tipo, conteudo) {
    const loja = await this.loja(lojaId);
    return this.imagens.trocar(loja.id, tipo, conteudo, { updatedAt: this.serverTimestamp() });
  }

  // ===== Agendamento contratado (scheduling.contracted) =====

  async agendamento(lojaId) {
    const data = (await this.loja(lojaId)).data() || {};
    return { lojaId, contracted: data.scheduling?.contracted === true, enabled: data.scheduling?.enabled === true };
  }

  // Tirar o contrato desliga tambem o agendamento da loja.
  async contratarAgendamento(lojaId, contratado) {
    const loja = await this.loja(lojaId);
    const atualizacao = { 'scheduling.contracted': contratado === true, updatedAt: this.serverTimestamp() };
    if (contratado !== true) atualizacao['scheduling.enabled'] = false;
    await loja.ref.update(atualizacao);
    return this.agendamento(loja.id);
  }

  resumoDaLoja(documento) {
    const data = documento.data() || {};
    return {
      id: documento.id,
      nome: data.name || data.nomeEstabelecimento || documento.id,
      name: data.name || null,
      nomeEstabelecimento: data.nomeEstabelecimento || null,
      address: data.address ? Object.fromEntries(CAMPOS_ENDERECO.map((parte) => [parte, data.address[parte] ?? (parte === 'uf' ? data.address.state : null) ?? null])) : null,
      phone: data.phone || null,
      cnpj: data.cnpj || String(data.cpfOrCnpj || '').replace(/\D/g, '') || null,
      ativa: data.isActive !== false,
      status: data.status || null,
      criadaEm: quandoIso(data.createdAt),
    };
  }

  async resumo(lojaId) {
    return this.resumoDaLoja(await this.loja(lojaId));
  }
}
