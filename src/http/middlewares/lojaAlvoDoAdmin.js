import { AppError } from '../../domain/errors/AppError.js';

// Admin da plataforma agindo numa loja escolhida (Ficha de implantacao no Admin, agentes,
// importacao CSV e /brain com seletor). O painel manda o cabecalho X-Loja-Alvo; aqui a conta e
// conferida como admin (usersAdmin) em toda chamada e a loja precisa existir. Sem o cabecalho,
// nada muda. Quem nao e admin e manda o cabecalho recebe 403.
export function createLojaAlvoDoAdmin({ isPlatformAdminForRequest, firestore }) {
  return async (request, _response, next) => {
    try {
      const lojaAlvo = String(request.headers['x-loja-alvo'] || '').trim();
      if (!lojaAlvo) {
        next();
        return;
      }
      if (!request.auth?.uid) {
        throw new AppError('Login obrigatorio para usar este recurso.', { statusCode: 401, code: 'auth_token_required' });
      }
      if (!(await isPlatformAdminForRequest(request))) {
        throw new AppError('So o admin da plataforma age em outra loja.', { statusCode: 403, code: 'platform_admin_required' });
      }
      if (lojaAlvo.includes('/') || !(await firestore.collection('estabelecimentos').doc(lojaAlvo).get()).exists) {
        throw new AppError('Loja não encontrada.', { statusCode: 404, code: 'loja_alvo_nao_encontrada' });
      }
      request.lojaAlvo = lojaAlvo;
      next();
    } catch (error) {
      next(error);
    }
  };
}

// Conta do admin agindo na loja: passa como dono (todas as permissoes) daquela loja.
export function contaDoAdminNaLoja(uid, lojaAlvo) {
  return {
    uid,
    userId: uid,
    establishmentId: lojaAlvo,
    hasEstablishment: true,
    porAdminDaPlataforma: true,
    permissions: { isAdmin: true, groupId: null, keys: [] },
  };
}
