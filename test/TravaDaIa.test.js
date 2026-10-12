import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/domain/errors/AppError.js';
import { createContaDeLojaOuAdminGuard } from '../src/http/middlewares/requireContaDeLojaOuAdmin.js';

const semLoja = () => { throw new AppError('Conta sem estabelecimento ativo.', { statusCode: 403, code: 'data_establishment_required' }); };

function guarda({ conta, admin = false }) {
  return createContaDeLojaOuAdminGuard({
    accountForRequest: async () => conta(),
    isPlatformAdminForRequest: async () => admin,
  });
}

async function rodar(middleware, request) {
  return new Promise((resolve) => { middleware(request, {}, (error) => resolve(error)); });
}

test('conta de loja usa a IA', async () => {
  const erro = await rodar(guarda({ conta: () => ({ establishmentId: 'loja-a', hasEstablishment: true }) }), { auth: { uid: 'dono' } });
  assert.equal(erro, undefined);
});

test('admin da plataforma sem loja usa a IA', async () => {
  const erro = await rodar(guarda({ conta: semLoja, admin: true }), { auth: { uid: 'thay' } });
  assert.equal(erro, undefined);
});

test('conta logada sem loja e sem admin recebe 403', async () => {
  const erro = await rodar(guarda({ conta: semLoja, admin: false }), { auth: { uid: 'qualquer' } });
  assert.equal(erro.statusCode, 403);
  assert.equal(erro.code, 'ai_conta_sem_loja');
});

test('sem login recebe 401', async () => {
  const erro = await rodar(guarda({ conta: semLoja }), {});
  assert.equal(erro.statusCode, 401);
});

test('funcionario desativado continua recusado, mesmo sendo admin', async () => {
  const desativado = () => { throw new AppError('Esta conta de funcionario esta desativada.', { statusCode: 403, code: 'admin_user_disabled' }); };
  const erro = await rodar(guarda({ conta: desativado, admin: true }), { auth: { uid: 'func' } });
  assert.equal(erro.code, 'admin_user_disabled');
});
