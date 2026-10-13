import { FieldValue } from 'firebase-admin/firestore';
import { logger } from '../logger/logger.js';

// Registro de uma acao do admin da plataforma fora de /api/admin (Ficha de implantacao, agentes
// e importacao agindo numa loja escolhida). Mesmo formato do adminAudit.js: adminAuditLogs na
// raiz e estabelecimentos/{loja}/AdminAuditLogs.
export async function registrarAcaoDoAdmin(firestore, {
  uid, email = null, rota, metodo = 'POST', lojaId, detalhes = {}, serverTimestamp = () => FieldValue.serverTimestamp(),
}) {
  const quando = serverTimestamp();
  const details = { email, rota, metodo, lojas: [lojaId], ...detalhes };
  try {
    await Promise.all([
      firestore.collection('adminAuditLogs').add({ uid: uid || null, ...details, em: quando }),
      firestore.collection('estabelecimentos').doc(lojaId).collection('AdminAuditLogs')
        .add({ action: 'admin_plataforma', performedBy: uid || null, details, timestamp: quando }),
    ]);
  } catch (error) {
    logger.error('admin_audit_failed', { rota, originalMessage: error?.message });
  }
}
