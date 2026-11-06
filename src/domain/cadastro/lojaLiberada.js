import { AppError } from '../errors/AppError.js';

// Loja do cadastro novo so usa o painel depois de aprovada pelo Admin. Loja antiga, sem o
// campo status, segue como hoje.
export function lojaLiberada(establishmentDocument) {
  const status = establishmentDocument?.status;
  return !status || status === 'aprovada';
}

export function assertLojaLiberada(account) {
  if (lojaLiberada(account?.establishmentDocument)) return;
  const recusada = account.establishmentDocument.status === 'recusada';
  throw new AppError(recusada ? 'O pedido desta loja foi recusado.' : 'Seu pedido está em análise.', {
    statusCode: 403,
    code: recusada ? 'loja_recusada' : 'loja_em_analise',
    details: { status: account.establishmentDocument.status },
  });
}
