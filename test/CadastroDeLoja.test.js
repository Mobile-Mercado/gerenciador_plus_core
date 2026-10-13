import assert from 'node:assert/strict';
import test from 'node:test';
import { CadastroDeLoja } from '../src/application/cadastro/CadastroDeLoja.js';
import { converterParaWebp, ImagensDaLoja, LIMITE_ENTRADA_BYTES } from '../src/application/cadastro/ImagensDaLoja.js';
import { chaveDoLimite, LimiteDeTentativas } from '../src/application/cadastro/LimiteDeTentativas.js';
import { lerEmpresa } from '../src/infra/cnpj/BrasilApiCnpj.js';
import { AuthEmMemoria } from './apoio/authEmMemoria.js';
import { FirestoreEmMemoria } from './apoio/firestoreEmMemoria.js';

const CNPJ = '11222333000181';
const RECEITA_ATIVA = lerEmpresa({
  descricao_situacao_cadastral: 'ATIVA',
  razao_social: 'MERCADO BOM PRECO LTDA',
  descricao_tipo_de_logradouro: 'RUA',
  logradouro: 'SETE DE SETEMBRO',
  numero: '410',
  bairro: 'CENTRO',
  municipio: 'VITORIA',
  uf: 'ES',
  cep: '29015000',
});

function pedido(mudancas = {}) {
  return {
    cnpj: '11.222.333/0001-81',
    nome: 'Bom Preço',
    responsavel: { nome: 'Ana Paula', cpf: '529.982.247-25', celular: '(27) 99876-5432', email: 'ana@bompreco.com.br' },
    senha: 'senha-forte',
    ...mudancas,
  };
}

function montar({ dados = {}, contas = [], receita = RECEITA_ATIVA, firestore = null, imagens = null } = {}) {
  const banco = firestore || new FirestoreEmMemoria(dados);
  const auth = new AuthEmMemoria(contas);
  const cadastro = new CadastroDeLoja({
    firestore: banco,
    auth,
    consultaCnpj: { consultar: async () => receita },
    limites: new LimiteDeTentativas({ firestore: banco, clock: () => 1_000_000, paraData: (ms) => new Date(ms) }),
    imagens,
    serverTimestamp: () => new Date('2026-10-13T12:00:00Z'),
  });
  return { banco, auth, cadastro };
}

async function recusa(promessa, codigo) {
  await assert.rejects(promessa, (erro) => erro.code === codigo);
}

test('caminho completo: conta, Users/{uid} e loja aguardando o e-mail, sem claim', async () => {
  const { banco, auth, cadastro } = montar();
  const criado = await cadastro.criar(pedido(), { ip: '200.1.1.1' });
  assert.equal(criado.status, 'aguardando_email');
  assert.equal(criado.cnpjConferido, true);

  const usuario = banco.dados(`Users/${criado.uid}`);
  assert.equal(usuario.id, criado.uid);
  assert.equal(usuario.userAuthId, criado.uid);
  assert.equal(usuario.userType, 'UserType.empresa');
  assert.equal(usuario.whitelabelId, 'br.com.mobile.gerenciador');
  assert.equal('rgDocument' in usuario || 'dateOfBirth' in usuario, false);

  const loja = banco.dados(`estabelecimentos/${criado.lojaId}`);
  assert.equal(loja.name, 'Bom Preço');
  assert.equal(loja.razaoSocial, 'MERCADO BOM PRECO LTDA');
  assert.equal(loja.cnpj, CNPJ);
  assert.equal(loja.cnpjConferido, true);
  assert.equal(loja.address.city, 'VITORIA');
  assert.equal(loja.phone, '27998765432');
  assert.equal(loja.isActive, false);
  assert.equal(loja.status, 'aguardando_email');
  assert.equal(loja.origemCadastro, 'app_gerenciador');
  assert.equal(loja.userReference.path, `Users/${criado.uid}`);
  assert.deepEqual((await auth.getUser(criado.uid)).customClaims, {});

  // Sem e-mail confirmado, o pedido nao sai.
  await recusa(cadastro.enviarPedido(criado.uid), 'cadastro_email_nao_confirmado');
  auth.confirmarEmail(criado.uid);
  const enviado = await cadastro.enviarPedido(criado.uid);
  assert.equal(enviado.status, 'em_analise');
  assert.equal(enviado.situacao, 'em_analise');
  assert.equal(banco.dados(`estabelecimentos/${criado.lojaId}`).status, 'em_analise');
  assert.ok(banco.dados(`estabelecimentos/${criado.lojaId}`).enviadoEm);
  // Mandar de novo nao muda nada.
  assert.equal((await cadastro.enviarPedido(criado.uid)).status, 'em_analise');
});

test('consulta da Receita que falhou segue com cnpjConferido false', async () => {
  const { banco, cadastro } = montar({ receita: null });
  const criado = await cadastro.criar(pedido());
  assert.equal(criado.cnpjConferido, false);
  assert.equal(banco.dados(`estabelecimentos/${criado.lojaId}`).razaoSocial, null);
});

test('recusas: CNPJ inativo, desconhecido, ja usado e e-mail ja usado', async () => {
  await recusa(montar({ receita: { encontrado: true, ativa: false, situacao: 'BAIXADA' } }).cadastro.criar(pedido()), 'cadastro_cnpj_inativo');
  await recusa(montar({ receita: { encontrado: false } }).cadastro.criar(pedido()), 'cadastro_cnpj_inativo');
  await recusa(
    montar({ dados: { 'estabelecimentos/antiga': { cpfOrCnpj: '11.222.333/0001-81' } } }).cadastro.criar(pedido()),
    'cadastro_cnpj_em_uso',
  );
  await recusa(
    montar({ dados: { 'estabelecimentos/pedido': { cnpj: CNPJ, status: 'em_analise' } } }).cadastro.criar(pedido()),
    'cadastro_cnpj_em_uso',
  );
  // Pedido recusado nao prende o CNPJ.
  const recusado = await montar({ dados: { 'estabelecimentos/velho': { cnpj: CNPJ, status: 'recusada' } } }).cadastro.criar(pedido());
  assert.equal(recusado.status, 'aguardando_email');
  await recusa(
    montar({ contas: [{ uid: 'outro', email: 'ana@bompreco.com.br' }] }).cadastro.criar(pedido()),
    'cadastro_email_em_uso',
  );
});

test('recusas de campo: nome com emoji, CPF errado, celular sem 9, senha curta', async () => {
  const { cadastro } = montar();
  await recusa(cadastro.criar(pedido({ nome: 'Bom 🛒' })), 'cadastro_nome_invalido');
  await recusa(cadastro.criar(pedido({ responsavel: { ...pedido().responsavel, cpf: '111.111.111-11' } })), 'cadastro_cpf_invalido');
  await recusa(cadastro.criar(pedido({ responsavel: { ...pedido().responsavel, celular: '2733334444' } })), 'cadastro_celular_invalido');
  await recusa(cadastro.criar(pedido({ senha: 'curta' })), 'cadastro_senha_invalido');
});

test('limite de tentativas por CNPJ, guardado com hash e campo de expiracao', async () => {
  const { banco, cadastro } = montar({ receita: { encontrado: true, ativa: false } });
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    await recusa(cadastro.criar(pedido({ responsavel: { ...pedido().responsavel, email: `a${tentativa}@bp.com.br` } }), { ip: `10.0.0.${tentativa}` }), 'cadastro_cnpj_inativo');
  }
  await recusa(cadastro.criar(pedido(), { ip: '10.0.0.99' }), 'cadastro_tentativas_excedidas');
  const contador = banco.dados(`limitesCadastro/${chaveDoLimite('cnpj', CNPJ)}`);
  assert.equal(contador.contagem, 5);
  assert.ok(contador.expiraEm instanceof Date);
  assert.equal(JSON.stringify(contador).includes(CNPJ), false);
});

test('falha ao gravar no Firestore apaga a conta criada: nada fica solto', async () => {
  const banco = new FirestoreEmMemoria();
  const batchOriginal = banco.batch.bind(banco);
  banco.batch = () => {
    const lote = batchOriginal();
    lote.commit = async () => { throw new Error('falha de rede'); };
    return lote;
  };
  const { auth, cadastro } = montar({ firestore: banco });
  await assert.rejects(cadastro.criar(pedido()), /falha de rede/);
  assert.deepEqual(auth.apagadas, ['uid-novo-1']);
  assert.equal(auth.contas.size, 0);
});

test('situacao para o app: em analise, aprovado e recusado com motivo', async () => {
  const { banco, auth, cadastro } = montar();
  const { uid, lojaId } = await cadastro.criar(pedido());
  auth.confirmarEmail(uid);
  await cadastro.enviarPedido(uid);
  await banco.doc(`estabelecimentos/${lojaId}`).update({ status: 'recusada', motivoRecusa: 'CNPJ de outra atividade' });
  const situacao = await cadastro.situacao(uid);
  assert.equal(situacao.situacao, 'recusado');
  assert.equal(situacao.motivoRecusa, 'CNPJ de outra atividade');
  assert.equal(situacao.emailConfirmado, true);
});

test('imagens do cadastro: so o dono, so antes da decisao, e acima de 20 MB a mensagem diz o limite', async () => {
  const salvas = [];
  const imagens = { trocar: async (lojaId, tipo) => { salvas.push([lojaId, tipo]); return { campo: 'chatProfileImageUrl', url: 'u' }; } };
  const { banco, cadastro } = montar({ imagens });
  const { uid, lojaId } = await cadastro.criar(pedido());
  await cadastro.trocarImagem(uid, 'logo', Buffer.from('x'));
  assert.deepEqual(salvas, [[lojaId, 'logo']]);
  await recusa(cadastro.trocarImagem(uid, 'splash', Buffer.from('x')), 'imagem_tipo_invalido');
  await recusa(cadastro.trocarImagem('sem-loja', 'logo', Buffer.from('x')), 'cadastro_pedido_nao_encontrado');
  await banco.doc(`estabelecimentos/${lojaId}`).update({ status: 'aprovada' });
  await recusa(cadastro.trocarImagem(uid, 'logo', Buffer.from('x')), 'cadastro_imagem_fora_do_prazo');

  await assert.rejects(
    converterParaWebp(Buffer.alloc(LIMITE_ENTRADA_BYTES + 1), { largura: 512, altura: 512 }),
    (erro) => erro.code === 'imagem_acima_do_limite' && erro.statusCode === 413 && /20 MB/.test(erro.message),
  );
});

test('conversao: foto grande vira WEBP de ate 300 KB dentro do tamanho maximo', async () => {
  const { default: sharp } = await import('sharp');
  const foto = await sharp({ create: { width: 4000, height: 3000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
    .jpeg({ quality: 95 }).toBuffer();
  const webp = await converterParaWebp(foto, { largura: 1600, altura: 1200 });
  const meta = await sharp(webp).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok(meta.width <= 1600 && meta.height <= 1200);
  assert.ok(webp.length <= 300 * 1024);

  const gravados = [];
  const bucket = { name: 'bucket-teste', file: (caminho) => ({ save: async (conteudo, opcoes) => { gravados.push({ caminho, opcoes }); } }) };
  const banco = new FirestoreEmMemoria({ 'estabelecimentos/loja-1': { name: 'Loja' } });
  const servico = new ImagensDaLoja({ firestore: banco, bucket, converter: async () => Buffer.from('webp'), agora: () => 42 });
  const resultado = await servico.trocar('loja-1', 'logo', Buffer.from('foto'));
  assert.equal(gravados[0].caminho, 'appMobile/companyImages/loja-1/logo_42.webp');
  assert.equal(gravados[0].opcoes.contentType, 'image/webp');
  assert.equal(banco.dados('estabelecimentos/loja-1').chatProfileImageUrl, resultado.url);
});

test('rotas: POST /loja sem login, App Check quando ligado, login nas outras e foto acima de 20 MB', async () => {
  const { default: express } = await import('express');
  const { createCadastroRoutes } = await import('../src/http/routes/cadastroRoutes.js');
  const { createAppCheckMiddleware } = await import('../src/http/middlewares/appCheck.js');
  const { errorHandler } = await import('../src/http/middlewares/errorHandler.js');
  const { AppError } = await import('../src/domain/errors/AppError.js');
  const { cadastro } = montar({ imagens: { trocar: async () => ({ campo: 'chatProfileImageUrl', url: 'u' }) } });
  const exigirLogin = (request, _response, next) => {
    const uid = request.headers['x-teste-uid'];
    if (!uid) {
      next(new AppError('login', { statusCode: 401, code: 'auth_token_required' }));
      return;
    }
    request.auth = { uid };
    next();
  };
  const subir = (exigirAppCheck) => {
    const app = express();
    app.use(express.json());
    app.use('/api/cadastro', createCadastroRoutes({
      cadastroDeLoja: cadastro,
      appCheck: createAppCheckMiddleware({ exigir: exigirAppCheck, verificar: async (token) => { if (token !== 'ok') throw new Error('x'); } }),
      exigirLogin,
    }));
    app.use(errorHandler);
    return new Promise((resolve) => { const servidor = app.listen(0, () => resolve(servidor)); });
  };

  const servidor = await subir(false);
  const base = `http://127.0.0.1:${servidor.address().port}/api/cadastro`;
  try {
    const criada = await fetch(`${base}/loja`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pedido()) });
    assert.equal(criada.status, 201);
    const { data } = await criada.json();
    assert.equal((await fetch(`${base}/loja/situacao`)).status, 401);
    assert.equal((await (await fetch(`${base}/loja/situacao`, { headers: { 'x-teste-uid': data.uid } })).json()).data.status, 'aguardando_email');

    const grande = await fetch(`${base}/loja/imagens/logo`, {
      method: 'POST',
      headers: { 'x-teste-uid': data.uid, 'Content-Type': 'image/jpeg' },
      body: Buffer.alloc(LIMITE_ENTRADA_BYTES + 10),
    });
    assert.equal(grande.status, 413);
    const corpo = await grande.json();
    assert.equal(corpo.error.code, 'imagem_acima_do_limite');
    assert.match(corpo.error.message, /20 MB/);
  } finally {
    servidor.close();
  }

  const comAppCheck = await subir(true);
  const baseApp = `http://127.0.0.1:${comAppCheck.address().port}/api/cadastro`;
  try {
    const semToken = await fetch(`${baseApp}/loja`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(semToken.status, 401);
    assert.equal((await semToken.json()).error.code, 'app_check_obrigatorio');
  } finally {
    comAppCheck.close();
  }
});

test('foto acima de 50 megapixels e recusada com mensagem, e as conversoes rodam uma por vez', async () => {
  const { default: sharp } = await import('sharp');
  const { umaPorVez } = await import('../src/application/cadastro/ImagensDaLoja.js');
  const enorme = await sharp({ create: { width: 8000, height: 7000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.ok(enorme.length < LIMITE_ENTRADA_BYTES);
  await assert.rejects(
    converterParaWebp(enorme, { largura: 512, altura: 512 }),
    (erro) => erro.code === 'imagem_pixels_demais' && /50 megapixels/.test(erro.message),
  );
  const ordem = [];
  const trabalho = (nome, ms) => () => new Promise((resolve) => {
    ordem.push(`inicio ${nome}`);
    setTimeout(() => { ordem.push(`fim ${nome}`); resolve(nome); }, ms);
  });
  await Promise.all([umaPorVez(trabalho('a', 30)), umaPorVez(trabalho('b', 1)), umaPorVez(() => Promise.reject(new Error('x'))).catch(() => 'falhou'), umaPorVez(trabalho('c', 1))]);
  assert.deepEqual(ordem, ['inicio a', 'fim a', 'inicio b', 'fim b', 'inicio c', 'fim c']);
});
