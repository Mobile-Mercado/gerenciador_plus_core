import { FieldValue } from 'firebase-admin/firestore';
import { logger } from '../../infra/logger/logger.js';

// Registro de quem agiu pelo Admin: cada chamada que grava (tudo menos GET) vira um
// documento em adminAuditLogs (raiz) quando a resposta termina. Quando a acao tem loja alvo
// (parametro :lojaId, campo lojaId do corpo ou response.locals.lojasAlvo), grava tambem em
// estabelecimentos/{loja}/AdminAuditLogs, no formato que a tela de auditoria da loja ja le
// (action, performedBy, details, timestamp).
export function createAdminAuditMiddleware({ firestore, serverTimestamp = () => FieldValue.serverTimestamp() }) {
  return (request, response, next) => {
    if (request.method === 'GET') {
      next();
      return;
    }
    response.on('finish', () => {
      const lojas = lojasAlvo(request, response);
      const details = {
        email: request.auth?.email || null,
        rota: request.originalUrl,
        metodo: request.method,
        status: response.statusCode,
        lojas,
        ...(response.locals?.auditoria || {}),
      };
      const quando = serverTimestamp();
      const escritas = [
        firestore.collection('adminAuditLogs').add({ uid: request.auth?.uid || null, ...details, em: quando }),
        ...lojas.map((lojaId) => firestore
          .collection('estabelecimentos').doc(lojaId).collection('AdminAuditLogs')
          .add({ action: 'admin_plataforma', performedBy: request.auth?.uid || null, details, timestamp: quando })),
      ];
      Promise.all(escritas).catch((error) => {
        logger.error('admin_audit_failed', { rota: request.originalUrl, originalMessage: error?.message });
      });
    });
    next();
  };
}

function lojasAlvo(request, response) {
  const lojas = new Set();
  [request.params?.lojaId, request.body?.lojaId, ...(response.locals?.lojasAlvo || [])]
    .filter((valor) => typeof valor === 'string' && valor.trim())
    .forEach((valor) => lojas.add(valor.trim()));
  return [...lojas];
}
