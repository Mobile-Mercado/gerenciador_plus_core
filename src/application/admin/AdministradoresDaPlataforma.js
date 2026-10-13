import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { UIDS_QUE_CRIAM_ADMIN } from '../../config/uidsQueCriamAdmin.js';
import { validarEmail, validarSenha } from '../../domain/cadastro/validacoes.js';
import { quandoIso } from './PedidosDeLoja.js';

// Administradores da plataforma (usersAdmin). Listar: qualquer admin. Criar e "Remover acesso":
// so as contas do Thay (UIDS_QUE_CRIAM_ADMIN). Criar grava o mesmo que a createUserAdmin (claim
// isAdmin e usersAdmin/{uid}); conta que ja existe no login so ganha o acesso. Remover tira o
// admin (isAdmin false e a claim) sem apagar a conta.
export class AdministradoresDaPlataforma {
  constructor({ firestore, auth, uidsQueCriam = UIDS_QUE_CRIAM_ADMIN }) {
    this.firestore = firestore;
    this.auth = auth;
    this.uidsQueCriam = uidsQueCriam;
  }

  podeGerenciar(uid) {
    return this.uidsQueCriam.includes(uid);
  }

  assertPodeGerenciar(ator) {
    if (!this.podeGerenciar(ator?.uid)) {
      throw new AppError('Só as contas do Thay criam ou tiram admin.', { statusCode: 403, code: 'admin_so_thay' });
    }
  }

  async listar(ator = {}) {
    const snapshot = await this.firestore.collection('usersAdmin').get();
    return {
      podeGerenciar: this.podeGerenciar(ator.uid),
      admins: snapshot.docs.map((documento) => {
        const data = documento.data() || {};
        return {
          uid: documento.id,
          nome: data.nome || null,
          email: data.email || null,
          ativo: data.isAdmin === true,
          criadoEm: quandoIso(data.createdAt),
          ultimoAcesso: quandoIso(data.lastLogin),
        };
      }).sort((a, b) => Number(b.ativo) - Number(a.ativo) || String(a.nome).localeCompare(String(b.nome), 'pt-BR')),
    };
  }

  async criar({ nome, email, senha } = {}, ator = {}) {
    this.assertPodeGerenciar(ator);
    const nomeLimpo = String(nome || '').replace(/\s+/g, ' ').trim();
    if (nomeLimpo.length < 2 || nomeLimpo.length > 80) {
      throw new AppError('Escreva o nome do admin.', { statusCode: 400, code: 'admin_nome_invalido' });
    }
    const emailLimpo = validarEmail(email);
    let conta = null;
    try {
      conta = await this.auth.getUserByEmail(emailLimpo);
    } catch (error) {
      if (error?.code !== 'auth/user-not-found') throw error;
    }
    const contaNova = !conta;
    if (contaNova) {
      conta = await this.auth.createUser({
        email: emailLimpo, password: validarSenha(senha), displayName: nomeLimpo, emailVerified: false, disabled: false,
      });
    }
    await this.auth.setCustomUserClaims(conta.uid, { ...(conta.customClaims || {}), isAdmin: true });
    await this.firestore.collection('usersAdmin').doc(conta.uid).set({
      nome: nomeLimpo,
      email: emailLimpo,
      isAdmin: true,
      callOnWrite: true,
      updatedAt: FieldValue.serverTimestamp(),
      ...(contaNova ? { createdAt: FieldValue.serverTimestamp(), lastLogin: null } : {}),
    }, { merge: true });
    return { uid: conta.uid, contaNova };
  }

  async removerAcesso(uid, ator = {}) {
    this.assertPodeGerenciar(ator);
    if (uid === ator.uid) {
      throw new AppError('Você não pode tirar o seu próprio acesso.', { statusCode: 400, code: 'admin_remover_a_si' });
    }
    const referencia = this.firestore.collection('usersAdmin').doc(String(uid || ''));
    if (!(await referencia.get()).exists) {
      throw new AppError('Admin não encontrado.', { statusCode: 404, code: 'admin_nao_encontrado' });
    }
    const conta = await this.auth.getUser(uid);
    const claims = { ...(conta.customClaims || {}) };
    delete claims.isAdmin;
    await this.auth.setCustomUserClaims(uid, claims);
    await referencia.update({ isAdmin: false, callOnWrite: true, updatedAt: FieldValue.serverTimestamp() });
    return { uid, removido: true };
  }
}
