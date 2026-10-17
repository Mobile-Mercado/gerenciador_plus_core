import assert from 'node:assert/strict';
import test from 'node:test';
import { ManageImplantationPipelines } from '../src/application/implantacao/ManageImplantationPipelines.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

// Loja pronta para a aprovacao final (etapa 06 aberta), com o dono ligado por userReference e
// sem CPF: o cadastro na ordem nova nao pede mais o CPF.
function montar({ cpf = null, userReference = 'ref' } = {}) {
  const firestore = new FirestoreEmMemoria({
    'estabelecimentos/l1/implantacaoGrenciador/pipeline': { type: 'pipeline', unlockedSteps: ['01', '02', '03', '04', '05', '06'] },
    'Users/uid-dono': { id: 'uid-dono', userAuthId: 'uid-dono', ...(cpf ? { cpfDocument: cpf } : {}) },
  });
  const referencia = userReference === 'ref' ? firestore.doc('Users/uid-dono') : userReference;
  firestore.docs.set('estabelecimentos/l1', { name: 'Bom Preço', ...(referencia ? { userReference: referencia } : {}) });
  return { firestore, pipelines: new ManageImplantationPipelines({ firestore }) };
}

test('"Aprovar e lancar" recusa sem CPF gravado, com mensagem clara', async () => {
  const { firestore, pipelines } = montar();
  await assert.rejects(
    pipelines.aprovarFormalmente({ establishmentId: 'l1', nome: 'Ana Paula', uid: 'uid-dono' }),
    (erro) => erro.code === 'implantacao_cpf_obrigatorio' && erro.statusCode === 409
      && erro.message === 'Preencha o CPF do dono da empresa antes de aprovar o lançamento.',
  );
  assert.equal(firestore.dados('estabelecimentos/l1/implantacaoGrenciador/pipeline').aprovacaoFormal, undefined);
});

test('CPF do dono: valida como no cadastro, grava em Users do dono e mostra so os 2 ultimos', async () => {
  const { firestore, pipelines } = montar();
  assert.deepEqual(await pipelines.cpfDoDono('l1'), { temCpf: false, cpfMascarado: null });
  await assert.rejects(pipelines.gravarCpfDoDono({ establishmentId: 'l1', cpf: '111.111.111-11', uid: 'uid-dono' }), (erro) => erro.code === 'cadastro_cpf_invalido');
  await assert.rejects(pipelines.gravarCpfDoDono({ establishmentId: 'l1', cpf: '5299822472', uid: 'uid-dono' }), (erro) => erro.code === 'cadastro_cpf_invalido');

  const gravado = await pipelines.gravarCpfDoDono({ establishmentId: 'l1', cpf: '529.982.247-25', uid: 'uid-dono' });
  assert.deepEqual(gravado, { temCpf: true, cpfMascarado: '***.***.***-25' });
  const usuario = firestore.dados('Users/uid-dono');
  assert.equal(usuario.cpfDocument, '52998224725');
  assert.equal(usuario.cpfGravadoPor, 'uid-dono');
  assert.ok(usuario.cpfGravadoEm);

  const pipeline = await pipelines.aprovarFormalmente({ establishmentId: 'l1', nome: 'Ana Paula', uid: 'uid-dono' });
  assert.equal(pipeline.aprovacaoFormal.nome, 'Ana Paula');
});

test('CPF gravado no cadastro antigo vale; loja sem dono ligado recusa', async () => {
  const antigo = montar({ cpf: '52998224725' });
  assert.equal((await antigo.pipelines.aprovarFormalmente({ establishmentId: 'l1', nome: 'Ana', uid: 'u' })).aprovacaoFormal.nome, 'Ana');
  const textoDoCaminho = montar({ cpf: '52998224725', userReference: 'Users/uid-dono' });
  assert.equal((await textoDoCaminho.pipelines.cpfDoDono('l1')).temCpf, true);
  const semDono = montar({ userReference: null });
  await assert.rejects(semDono.pipelines.cpfDoDono('l1'), (erro) => erro.code === 'implantacao_loja_sem_dono');
});

test('rotas GET e POST /cpf-do-dono: so o dono logado, nunca o admin da plataforma na loja', async () => {
  const { default: express } = await import('express');
  const { createImplantacaoRoutes } = await import('../src/http/routes/implantacaoRoutes.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { firestore, pipelines } = montar();
  const contas = {
    dono: { establishmentId: 'l1', permissions: { isAdmin: true } },
    funcionario: { establishmentId: 'l1', permissions: { isAdmin: false, keys: ['products.edit'] } },
    plataforma: { establishmentId: 'l1', permissions: { isAdmin: true }, porAdminDaPlataforma: true },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/implantacao', (request, _response, next) => {
    request.auth = { uid: 'uid-dono' };
    next();
  }, createImplantacaoRoutes({
    manageImplantationPipelines: pipelines,
    implantationAdminMiddleware: (_request, _response, next) => next(),
    requirePermission: () => (_request, _response, next) => next(),
    accountForRequest: async (request) => contas[request.headers['x-conta']],
  }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}/api/implantacao/cpf-do-dono`;
  const gravar = (conta, cpf) => fetch(base, {
    method: 'POST', headers: { 'x-conta': conta, 'Content-Type': 'application/json' }, body: JSON.stringify({ cpf }),
  });
  try {
    assert.deepEqual((await (await fetch(base, { headers: { 'x-conta': 'dono' } })).json()).data, { temCpf: false, cpfMascarado: null });
    assert.equal((await gravar('funcionario', '52998224725')).status, 403);
    const plataforma = await gravar('plataforma', '52998224725');
    assert.equal(plataforma.status, 403);
    assert.equal((await plataforma.json()).error.code, 'implantacao_cpf_so_dono');
    const invalido = await gravar('dono', '123');
    assert.equal(invalido.status, 400);
    assert.equal((await invalido.json()).error.code, 'cadastro_cpf_invalido');
    const ok = await gravar('dono', '529.982.247-25');
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).data, { temCpf: true, cpfMascarado: '***.***.***-25' });
    assert.equal(firestore.dados('Users/uid-dono').cpfDocument, '52998224725');
  } finally {
    servidor.close();
  }
});
