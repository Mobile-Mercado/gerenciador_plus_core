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

const ENDERECO = {
  cep: '29015-000',
  rua: 'Rua Sete de Setembro',
  numero: '410',
  complemento: 'Loja 2',
  bairro: 'Centro',
  cidade: 'Vitória',
  uf: 'ES',
  referencia: 'Em frente à praça',
  lat: -20.3194,
  lng: -40.3378,
};

function pedido(mudancas = {}) {
  return {
    cnpj: '11.222.333/0001-81',
    nome: 'Bom Preço',
    responsavel: { nome: 'Ana Paula', celular: '(27) 99876-5432', email: 'ana@bompreco.com.br' },
    erp: { escolhido: 'Linear', texto: null },
    endereco: ENDERECO,
    instalacaoId: 'inst-abc-12345',
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
    pontoNoMapa: (latitude, longitude) => ({ latitude, longitude }),
  });
  return { banco, auth, cadastro };
}

async function recusa(promessa, codigo) {
  await assert.rejects(promessa, (erro) => erro.code === codigo);
}

test('caminho completo: conta, Users/{uid} e pedido aguardando o e-mail, sem loja e sem claim', async () => {
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
  // Sem CPF: o campo nao nasce.
  assert.equal('cpfDocument' in usuario, false);

  // O pedido nao cria loja: so pedidosDeLoja/{id}, e Users guarda o id do pedido.
  assert.equal(criado.lojaId, undefined);
  assert.equal([...banco.docs.keys()].some((caminho) => caminho.startsWith('estabelecimentos/')), false);
  assert.equal(usuario.pedidoDeLojaId, criado.pedidoId);
  const loja = banco.dados(`pedidosDeLoja/${criado.pedidoId}`);
  assert.equal(loja.id, criado.pedidoId);
  assert.equal(loja.uid, criado.uid);
  assert.equal(loja.lojaId, null);
  assert.equal(loja.name, 'Bom Preço');
  assert.equal(loja.razaoSocial, 'MERCADO BOM PRECO LTDA');
  assert.equal(loja.cnpj, CNPJ);
  assert.equal(loja.cnpjConferido, true);
  // Endereco confirmado no mapa, no formato das lojas existentes; o da Receita fica a parte.
  assert.deepEqual(loja.address.position, { latitude: -20.3194, longitude: -40.3378 });
  assert.equal(loja.address.city, 'Vitória');
  assert.equal(loja.address.number, '410');
  assert.equal(loja.address.zipCode, '29015000');
  assert.equal(loja.address.reference, 'Em frente à praça');
  assert.equal(loja.address.fullAddress, 'Rua Sete de Setembro, 410, Centro, Vitória - ES');
  assert.equal(loja.enderecoReceita.city, 'VITORIA');
  assert.deepEqual(loja.erp, { escolhido: 'Linear', texto: null });
  assert.equal(loja.instalacaoId, 'inst-abc-12345');
  assert.equal(loja.cnpjRepetido, false);
  assert.equal(loja.cnpjAtivo, true);
  assert.equal(loja.phone, '27998765432');
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
  assert.equal(banco.dados(`pedidosDeLoja/${criado.pedidoId}`).status, 'em_analise');
  assert.ok(banco.dados(`pedidosDeLoja/${criado.pedidoId}`).enviadoEm);
  // Mandar de novo nao muda nada.
  assert.equal((await cadastro.enviarPedido(criado.uid)).status, 'em_analise');
});

test('consulta da Receita que falhou segue com cnpjConferido false', async () => {
  const { banco, cadastro } = montar({ receita: null });
  const criado = await cadastro.criar(pedido());
  assert.equal(criado.cnpjConferido, false);
  assert.equal(banco.dados(`pedidosDeLoja/${criado.pedidoId}`).razaoSocial, null);
});

test('CNPJ inativo ou desconhecido na Receita nao bloqueia: o pedido guarda a situacao', async () => {
  const inativo = montar({ receita: { encontrado: true, ativa: false, situacao: 'BAIXADA', razaoSocial: 'X LTDA', endereco: null } });
  const criadoInativo = await inativo.cadastro.criar(pedido());
  const lojaInativa = inativo.banco.dados(`pedidosDeLoja/${criadoInativo.pedidoId}`);
  assert.equal(lojaInativa.cnpjConferido, true);
  assert.equal(lojaInativa.cnpjAtivo, false);
  assert.equal(lojaInativa.cnpjSituacao, 'BAIXADA');

  const desconhecido = montar({ receita: { encontrado: false } });
  const criadoDesconhecido = await desconhecido.cadastro.criar(pedido());
  assert.equal(desconhecido.banco.dados(`pedidosDeLoja/${criadoDesconhecido.pedidoId}`).cnpjAtivo, false);

  // Consulta num banco sem o pedido criado acima (com ele, o CNPJ ja teria cadastro).
  const consulta = await montar({ receita: { encontrado: true, ativa: false, situacao: 'BAIXADA', razaoSocial: 'X LTDA', endereco: null } })
    .cadastro.consultarCnpj('11.222.333/0001-81');
  assert.equal(consulta.encontrado, true);
  assert.equal(consulta.ativa, false);
  assert.equal('cnpjRepetido' in consulta, false, 'CNPJ livre: a consulta nao traz campo de repeticao');
});

// 409 do E10: so codigo, mensagem e o campo; nada da conta, loja ou pedido que ja existe.
function cnpjJaCadastrado(erro) {
  assert.equal(erro.code, 'cnpj_ja_cadastrado');
  assert.equal(erro.statusCode, 409);
  assert.equal(erro.message, 'Este CNPJ já tem cadastro na Móbile.');
  assert.deepEqual(erro.details, { campo: 'cnpj' });
  return true;
}

test('CNPJ que ja tem cadastro (27/10): consulta e criacao recusam com 409, sem criar conta nem pedido', async () => {
  // Loja antiga com o CNPJ formatado: a consulta do passo do CNPJ recusa antes da Receita.
  const antiga = montar({ dados: { 'estabelecimentos/antiga': { cpfOrCnpj: '11.222.333/0001-81', email: 'dono@antigo.com.br' } } });
  let consultasNaReceita = 0;
  antiga.cadastro.consultaCnpj = { consultar: async () => { consultasNaReceita += 1; return RECEITA_ATIVA; } };
  await assert.rejects(antiga.cadastro.consultarCnpj('11.222.333/0001-81'), cnpjJaCadastrado);
  assert.equal(consultasNaReceita, 0);
  // A criacao tambem recusa: nenhuma conta no Auth, nenhum Users nem pedido.
  await assert.rejects(antiga.cadastro.criar(pedido()), cnpjJaCadastrado);
  assert.equal(antiga.auth.contas.size, 0);
  assert.equal([...antiga.banco.docs.keys()].some((caminho) => /^(Users|pedidosDeLoja)\//.test(caminho)), false);

  // Mesmo criterio do antigo cnpjRepetido: loja com os digitos em cnpj ou o formato antigo em
  // cpfOrCpnf, e pedido em qualquer situacao (recusados inclusive).
  const casos = [
    { 'estabelecimentos/nova': { cnpj: CNPJ } },
    { 'estabelecimentos/digitos': { cpfOrCnpj: CNPJ } },
    { 'estabelecimentos/velha': { cpfOrCpnf: '11.222.333/0001-81' } },
    { 'estabelecimentos/velho': { cnpj: CNPJ, status: 'recusada' } },
    { 'pedidosDeLoja/parado': { cnpj: CNPJ, status: 'aguardando_email' } },
    { 'pedidosDeLoja/pedido': { cnpj: CNPJ, status: 'em_analise' } },
    { 'pedidosDeLoja/recusado': { cnpj: CNPJ, status: 'recusada' } },
  ];
  for (const dados of casos) {
    await assert.rejects(montar({ dados }).cadastro.consultarCnpj(CNPJ), cnpjJaCadastrado);
    await assert.rejects(montar({ dados }).cadastro.criar(pedido()), cnpjJaCadastrado);
  }

  // Outro CNPJ segue normal; o segundo cadastro do mesmo CNPJ e recusado.
  const livre = montar({ dados: { 'estabelecimentos/outra': { cnpj: '11444777000161' } } });
  const criado = await livre.cadastro.criar(pedido());
  assert.equal(criado.cnpjRepetido, false);
  const novo = livre.banco.dados(`pedidosDeLoja/${criado.pedidoId}`);
  assert.equal(novo.cnpjRepetido, false);
  assert.deepEqual(novo.lojasComOMesmoCnpj, []);
  assert.deepEqual(novo.pedidosComOMesmoCnpj, []);
  await assert.rejects(livre.cadastro.consultarCnpj(CNPJ), cnpjJaCadastrado);
  await assert.rejects(
    livre.cadastro.criar(pedido({ responsavel: { ...pedido().responsavel, email: 'outra@bompreco.com.br' } })),
    cnpjJaCadastrado,
  );
});

test('e-mail repetido continua bloqueando', async () => {
  await assert.rejects(
    montar({ contas: [{ uid: 'outro', email: 'ana@bompreco.com.br' }] }).cadastro.criar(pedido()),
    (erro) => erro.code === 'cadastro_email_em_uso' && erro.statusCode === 409 && /já tem cadastro/.test(erro.message),
  );
});

test('CPF fora do cadastro: no corpo e ignorado; ERP, endereco e instalacao validados', async () => {
  const { banco, cadastro } = montar();
  const comCpf = await cadastro.criar(pedido({ responsavel: { ...pedido().responsavel, cpf: '111.111.111-11' } }));
  assert.equal('cpfDocument' in banco.dados(`Users/${comCpf.uid}`), false);
  const { userReference, ...loja } = banco.dados(`pedidosDeLoja/${comCpf.pedidoId}`);
  assert.equal(JSON.stringify(loja).includes('11111111111'), false);
  await recusa(montar().cadastro.criar(pedido({ erp: { escolhido: 'Sistema X' } })), 'cadastro_erp_invalido');
  await recusa(montar().cadastro.criar(pedido({ endereco: { ...ENDERECO, numero: '' } })), 'cadastro_numero_invalido');
  await recusa(montar().cadastro.criar(pedido({ endereco: { ...ENDERECO, lat: undefined } })), 'cadastro_lat_invalido');
  await recusa(montar().cadastro.criar(pedido({ instalacaoId: 'curto' })), 'cadastro_instalacao_invalido');
});

test('recusas de campo: nome com emoji, celular sem 9, senha curta', async () => {
  const { cadastro } = montar();
  await recusa(cadastro.criar(pedido({ nome: 'Bom 🛒' })), 'cadastro_nome_invalido');
  await recusa(cadastro.criar(pedido({ responsavel: { ...pedido().responsavel, celular: '2733334444' } })), 'cadastro_celular_invalido');
  await recusa(cadastro.criar(pedido({ senha: 'curta' })), 'cadastro_senha_invalido');
});

test('limite de tentativas por CNPJ, guardado com hash e campo de expiracao', async () => {
  const { banco, cadastro } = montar({ receita: { encontrado: true, ativa: false } });
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const criacao = cadastro.criar(pedido({ responsavel: { ...pedido().responsavel, email: `a${tentativa}@bp.com.br` } }), { ip: `10.0.0.${tentativa}` });
    // Depois do primeiro pedido, o CNPJ ja tem cadastro: a recusa tambem conta no limite.
    if (tentativa === 0) await criacao;
    else await recusa(criacao, 'cnpj_ja_cadastrado');
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
  const { uid, pedidoId } = await cadastro.criar(pedido());
  auth.confirmarEmail(uid);
  const enviado = await cadastro.enviarPedido(uid);
  assert.deepEqual({ status: enviado.status, motivo: enviado.motivo, lojaId: enviado.lojaId, nomeDaLoja: enviado.nomeDaLoja }, {
    status: 'em_analise', motivo: null, lojaId: null, nomeDaLoja: 'Bom Preço',
  });
  await banco.doc(`pedidosDeLoja/${pedidoId}`).update({ status: 'recusada', motivoRecusa: 'CNPJ de outra atividade' });
  const situacao = await cadastro.situacao(uid);
  assert.equal(situacao.situacao, 'recusado');
  assert.equal(situacao.motivo, 'CNPJ de outra atividade');
  assert.equal(situacao.lojaId, null);
  assert.equal(situacao.emailConfirmado, true);
  // Aprovado: o lojaId aparece.
  await banco.doc(`pedidosDeLoja/${pedidoId}`).update({ status: 'aprovada', lojaId: 'loja-nova' });
  const aprovado = await cadastro.situacao(uid);
  assert.equal(aprovado.situacao, 'aprovado');
  assert.equal(aprovado.lojaId, 'loja-nova');
  assert.equal(aprovado.motivo, null);
});

test('imagens do cadastro: so o dono, so antes da decisao, e acima de 20 MB a mensagem diz o limite', async () => {
  const salvas = [];
  const imagens = { trocar: async (lojaId, tipo) => { salvas.push([lojaId, tipo]); return { campo: 'chatProfileImageUrl', url: 'u' }; } };
  // Rota sem uso desde 17/10/2026 (logo e fachada sairam do cadastro): continua lendo a loja
  // do dono em estabelecimentos.
  const { banco, cadastro } = montar({ imagens });
  const uid = 'uid-dono';
  const lojaId = 'loja-dono';
  banco.docs.set(`estabelecimentos/${lojaId}`, { name: 'Loja', status: 'em_analise', userReference: banco.doc(`Users/${uid}`) });
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

    // CNPJ que ja tem cadastro (o pedido criado acima): 409 na consulta e na criacao, com o corpo
    // so com codigo, mensagem e campo, sem dado do pedido ou da conta existente.
    const corpoDoE10 = { error: { code: 'cnpj_ja_cadastrado', message: 'Este CNPJ já tem cadastro na Móbile.', details: { campo: 'cnpj' } } };
    const consulta = await fetch(`${base}/loja/cnpj`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cnpj: CNPJ }) });
    assert.equal(consulta.status, 409);
    assert.deepEqual(await consulta.json(), corpoDoE10);
    const outraConta = pedido({ responsavel: { ...pedido().responsavel, email: 'outra@bompreco.com.br' } });
    const repetida = await fetch(`${base}/loja`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(outraConta) });
    assert.equal(repetida.status, 409);
    assert.deepEqual(await repetida.json(), corpoDoE10);
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

test('C3.1: limite por IP de 5 tentativas por dia; CNPJ e e-mail como estavam', async () => {
  const { LIMITES } = await import('../src/application/cadastro/LimiteDeTentativas.js');
  assert.deepEqual(LIMITES.ip, { maximo: 5, janelaMs: 24 * 60 * 60 * 1000 });
  assert.deepEqual(LIMITES.cnpj, { maximo: 5, janelaMs: 24 * 60 * 60 * 1000 });
  assert.deepEqual(LIMITES.email, { maximo: 5, janelaMs: 24 * 60 * 60 * 1000 });
  const { cadastro } = montar({ receita: { encontrado: true, ativa: false } });
  // CNPJs validos e diferentes: so o IP se repete.
  const cnpjValido = (base) => {
    const digito = (numeros, pesos) => { const resto = numeros.reduce((soma, n, i) => soma + n * pesos[i], 0) % 11; return resto < 2 ? 0 : 11 - resto; };
    const numeros = base.split('').map(Number);
    const primeiro = digito(numeros, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return base + primeiro + digito([...numeros, primeiro], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  };
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    assert.equal((await cadastro.consultarCnpj(cnpjValido(`1122233300${10 + tentativa}`), { ip: '200.9.9.9' })).ativa, false);
  }
  await recusa(cadastro.consultarCnpj(cnpjValido('112223330099'), { ip: '200.9.9.9' }), 'cadastro_tentativas_excedidas');
  assert.equal((await cadastro.consultarCnpj(cnpjValido('112223330098'), { ip: '200.9.9.10' })).ativa, false);
});

test('C3.2 (temporario): registro do X-Forwarded-For so com quantidade e posicoes do Google, nunca os IPs', async () => {
  const { default: express } = await import('express');
  const { createCadastroRoutes, resumoDoEncaminhamento } = await import('../src/http/routes/cadastroRoutes.js');
  assert.deepEqual(resumoDoEncaminhamento('203.0.113.7, 35.191.10.4'), { quantidade: 2, posicoesDoGoogle: [1] });
  assert.deepEqual(resumoDoEncaminhamento('130.211.1.2,198.51.100.1, 130.211.4.1'), { quantidade: 3, posicoesDoGoogle: [0] });
  assert.deepEqual(resumoDoEncaminhamento(undefined), { quantidade: 0, posicoesDoGoogle: [] });
  const registros = [];
  const { cadastro } = montar();
  const app = express();
  app.use(express.json());
  app.use('/api/cadastro', createCadastroRoutes({
    cadastroDeLoja: cadastro,
    appCheck: (_request, _response, next) => next(),
    exigirLogin: (_request, _response, next) => next(),
    registrar: (meta) => registros.push(meta),
  }));
  const servidor = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${servidor.address().port}/api/cadastro`;
    await fetch(`${base}/loja/cnpj`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7, 35.191.10.4' }, body: '{"cnpj":"1"}' });
    await fetch(`${base}/loja/situacao`);
  } finally {
    servidor.close();
  }
  assert.deepEqual(registros, [
    { path: '/api/cadastro/loja/cnpj', quantidade: 2, posicoesDoGoogle: [1] },
    { path: '/api/cadastro/loja/situacao', quantidade: 0, posicoesDoGoogle: [] },
  ]);
  assert.equal(JSON.stringify(registros).includes('203.0.113.7'), false);
});
