import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { InstalacoesDosApps } from '../src/application/admin/InstalacoesDosApps.js';
import { errorHandler } from '../src/http/middlewares/errorHandler.js';
import { createPlatformAdminGuard } from '../src/http/middlewares/requirePlatformAdmin.js';
import { createAdminRoutes } from '../src/http/routes/adminRoutes.js';

// Tela Instalacoes do Admin (16/10/2026): leitura dos Stats/instalacoesApp e "Atualizar agora".

// Banco falso: documentos por caminho, getAll, get(campo) no snapshot e transacao simples.
function bancoFalso(documentos) {
  const docs = new Map(Object.entries(documentos));
  const registro = { lidos: [], gravados: [] };
  const snapshot = (caminho) => {
    const dados = docs.get(caminho);
    return { id: caminho.split('/').at(-1), exists: dados !== undefined, data: () => dados, get: (campo) => dados?.[campo] };
  };
  const referencia = (caminho) => ({
    id: caminho.split('/').at(-1),
    path: caminho,
    collection: (nome) => ({ doc: (id) => referencia(`${caminho}/${nome}/${id}`) }),
    get: async () => { registro.lidos.push(caminho); return snapshot(caminho); },
    set: async (dados, opcoes) => {
      registro.gravados.push(caminho);
      docs.set(caminho, opcoes?.merge ? { ...(docs.get(caminho) || {}), ...dados } : dados);
    },
  });
  return {
    registro,
    docs,
    doc: (caminho) => referencia(caminho),
    collection: (nome) => ({ doc: (id) => referencia(`${nome}/${id}`) }),
    getAll: async (...referencias) => Promise.all(referencias.map((item) => item.get())),
    runTransaction: async (acao) => acao({ get: (item) => item.get(), set: (item, dados, opcoes) => item.set(dados, opcoes) }),
  };
}

const LOJAS = {
  'CoreJobs/verifyProductImageFiles': { enabled: true, establishmentIds: ['zg', 'teste'] },
  'estabelecimentos/zg': { name: 'Zero Grau', whitelabelId: 'br.com.zero.grau' },
  'estabelecimentos/teste': { name: 'Teste', whitelabelId: 'br.com.zero.grau-teste' },
  'estabelecimentos/zg/Stats/instalacoesApp': {
    instaladosAgora: { android: 87, ios: 0 },
    totalInstalacoes: { android: 460, ios: 0 },
    totalDesinstalacoes: { android: 395, ios: 0 },
    dadosAte: { android: '2026-10-12', ios: null },
    atualizadoEm: { toDate: () => new Date('2026-10-16T18:42:00Z') },
    dias: { '2026-10-12': { android: { baixaram: 1, desinstalaram: 0 } } },
  },
};

test('listar: so lojas com app, uma leitura do Stats/instalacoesApp por loja, atualizadoEm em ISO', async () => {
  const banco = bancoFalso(LOJAS);
  const servico = new InstalacoesDosApps({ firestore: banco, FieldValue: {}, fontes: async () => { throw new Error('nao deveria ler fontes'); } });
  const { lojas } = await servico.listar();
  assert.deepEqual(lojas.map((loja) => [loja.id, loja.nome, loja.android, loja.ios]), [['zg', 'Zero Grau', 'br.com.zero.grau', 'br.com.zero.grau']]);
  assert.equal(lojas[0].documento.atualizadoEm, '2026-10-16T18:42:00.000Z');
  assert.equal(lojas[0].documento.totalInstalacoes.android, 460);
  assert.equal(banco.registro.lidos.filter((caminho) => caminho.endsWith('/Stats/instalacoesApp')).length, 1);
  assert.deepEqual(banco.registro.gravados, []);
});

test('atualizar: um por vez (409 enquanto roda), solta a trava no fim e mesmo com erro', async () => {
  const banco = bancoFalso(LOJAS);
  let liberar;
  const espera = new Promise((pronto) => { liberar = pronto; });
  const servico = new InstalacoesDosApps({
    firestore: banco,
    FieldValue: { serverTimestamp: () => 'agora' },
    agora: () => Date.parse('2026-10-16T19:00:00Z'),
    fontes: async () => { await espera; return { bucket: null, apple: null }; },
  });
  const primeira = servico.atualizar();
  await new Promise((pronto) => { setImmediate(pronto); });
  await assert.rejects(servico.atualizar(), (erro) => erro.statusCode === 409 && erro.code === 'instalacoes_atualizando');
  liberar();
  const resultado = await primeira;
  assert.deepEqual(resultado.lojas.map((linha) => [linha.establishmentId, linha.status || 'ok']), [['teste', 'sem-app'], ['zg', 'ok']]);
  assert.equal(banco.docs.get('CoreJobs/instalacoesAppAtualizacao').rodandoDesde, null);
  // Erro nas fontes: a trava sai do mesmo jeito e o erro chega a quem chamou.
  const comErro = new InstalacoesDosApps({ firestore: banco, FieldValue: {}, fontes: async () => { throw new Error('sem segredo'); } });
  await assert.rejects(comErro.atualizar(), /sem segredo/);
  assert.equal(banco.docs.get('CoreJobs/instalacoesAppAtualizacao').rodandoDesde, null);
  // Trava velha (mais de 15 minutos) nao segura o botao.
  banco.docs.set('CoreJobs/instalacoesAppAtualizacao', { rodandoDesde: Date.parse('2026-10-16T18:00:00Z') });
  await servico.atualizar();
});

async function subir({ instalacoesDosApps }) {
  const { requirePlatformAdmin } = createPlatformAdminGuard({
    platformAdminRepository: { isPlatformAdmin: async (uid) => uid === 'uid-admin' },
  });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const uid = request.headers['x-teste-uid'];
    if (uid) request.auth = { uid };
    next();
  });
  app.use('/api/admin', requirePlatformAdmin, createAdminRoutes({ manageCatalogoPadrao: {}, sugestoesDosClientes: {}, instalacoesDosApps }));
  app.use(errorHandler);
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${servidor.address().port}/api/admin`, fechar: () => new Promise((resolve) => { servidor.close(resolve); }) };
}

test('rotas: sem admin da plataforma, 403 (e 401 sem login); admin le e atualiza; ja atualizando, 409', async () => {
  const chamadas = [];
  let ocupado = false;
  const instalacoesDosApps = {
    listar: async () => { chamadas.push('listar'); return { lojas: [] }; },
    atualizar: async () => {
      chamadas.push('atualizar');
      if (ocupado) {
        const { AppError } = await import('../src/domain/errors/AppError.js');
        throw new AppError('Já está atualizando. Aguarde terminar.', { statusCode: 409, code: 'instalacoes_atualizando' });
      }
      return { lojas: [{ establishmentId: 'zg' }] };
    },
  };
  const { base, fechar } = await subir({ instalacoesDosApps });
  try {
    const pedir = (caminho, uid, metodo = 'GET') => fetch(`${base}${caminho}`, { method: metodo, headers: uid ? { 'x-teste-uid': uid } : {} });
    assert.equal((await pedir('/instalacoes', 'uid-lojista')).status, 403);
    assert.equal((await pedir('/instalacoes/atualizar', 'uid-lojista', 'POST')).status, 403);
    assert.equal((await pedir('/instalacoes')).status, 401);
    assert.deepEqual(chamadas, []);
    const lista = await pedir('/instalacoes', 'uid-admin');
    assert.equal(lista.status, 200);
    assert.deepEqual(await lista.json(), { data: { lojas: [] } });
    const atualizado = await pedir('/instalacoes/atualizar', 'uid-admin', 'POST');
    assert.equal(atualizado.status, 200);
    assert.deepEqual((await atualizado.json()).data, { lojas: [{ establishmentId: 'zg' }] });
    ocupado = true;
    const ocupada = await pedir('/instalacoes/atualizar', 'uid-admin', 'POST');
    assert.equal(ocupada.status, 409);
    assert.equal((await ocupada.json()).error.message, 'Já está atualizando. Aguarde terminar.');
  } finally {
    await fechar();
  }
});
