import { AppError } from '../../domain/errors/AppError.js';
import { sessaoEncerrada } from '../../application/sessoes/SessoesWeb.js';

// Item 5.10 "Acessos conectados": confere o cabecalho X-Sessao das chamadas da conta de loja.
// - Sessao encerrada pelo Admin (ou apagada pela limpeza de 7 dias sem uso): 401 sessao_encerrada.
// - Sem X-Sessao: aceita na transicao, os 7 dias depois da publicacao (SESSOES_WEB_PUBLICADO_EM).
//   Depois disso, so a chamada de navegador (com cabecalho Origin) sem X-Sessao recebe 401
//   sessao_obrigatoria: o App Gerenciador do celular chama /api/coupons e /api/loja/entregadores sem
//   navegador e sem X-Sessao, e continua passando. Sem a data, a transicao nao acaba.
// - Conta sem loja, admin da plataforma agindo em outra loja (X-Loja-Alvo, conferido depois em
//   lojaAlvoDoAdmin.js) e chamada sem login passam: as barreiras de cada rota decidem.
export const DIAS_DE_TRANSICAO = 7;

export function fimDaTransicao(publicadoEm) {
  if (!publicadoEm) return null;
  const data = new Date(publicadoEm);
  return Number.isNaN(data.getTime()) ? null : new Date(data.getTime() + DIAS_DE_TRANSICAO * 86_400_000);
}

export function createSessaoWebGuard({
  accountForRequest, sessoesWeb, publicadoEm = null, clock = () => Date.now(),
}) {
  const exigirDesde = fimDaTransicao(publicadoEm);
  return async (request, _response, next) => {
    try {
      if (!request.auth?.uid || String(request.headers['x-loja-alvo'] || '').trim()) {
        next();
        return;
      }
      const sessaoId = String(request.headers['x-sessao'] || '').trim();
      const exigindo = Boolean(request.headers.origin) && exigirDesde && clock() >= exigirDesde.getTime();
      // Sem cabecalho e sem exigir: nem le a conta.
      if (!sessaoId && !exigindo) {
        next();
        return;
      }
      let conta;
      try {
        conta = await accountForRequest(request);
      } catch {
        next();
        return;
      }
      if (!conta?.establishmentId) {
        next();
        return;
      }
      if (!sessaoId) {
        throw new AppError('Entre novamente neste computador.', { statusCode: 401, code: 'sessao_obrigatoria' });
      }
      if ((await sessoesWeb.situacao({ lojaId: conta.establishmentId, sessaoId })) !== 'ativa') {
        throw sessaoEncerrada();
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
