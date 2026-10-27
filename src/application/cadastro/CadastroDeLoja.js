import { FieldValue, GeoPoint } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { formatarCnpj, validarCnpj, validarPedidoDeCadastro } from '../../domain/cadastro/validacoes.js';
import { logger } from '../../infra/logger/logger.js';

// Cadastro de loja feito pelo servidor. O app gerenciador manda o pedido e o Core cria, numa
// operacao so, a conta no Auth, Users/{uid} (com o id do pedido) e pedidosDeLoja/{id}. Desde
// 17/10/2026 (decisao do Thay) o pedido nao cria loja: estabelecimentos/{id} so nasce no
// "Aprovar" do Admin (PedidosDeLoja). Se a gravacao no Firestore falhar, a conta criada e apagada:
// nao fica conta solta. Nada recebe claim aqui; a claim vem na aprovacao.
//
// Situacoes do pedido (campo status do pedido):
//   aguardando_email -> em_analise -> em_conversa (marcada pela equipe) -> aprovada | recusada
export const STATUS = Object.freeze({
  AGUARDANDO_EMAIL: 'aguardando_email',
  EM_ANALISE: 'em_analise',
  EM_CONVERSA: 'em_conversa',
  APROVADA: 'aprovada',
  RECUSADA: 'recusada',
});
export const STATUS_DO_CADASTRO = Object.freeze([STATUS.AGUARDANDO_EMAIL, STATUS.EM_ANALISE]);
export const WHITELABEL_GERENCIADOR = 'br.com.mobile.gerenciador';
export const ORIGEM_APP_GERENCIADOR = 'app_gerenciador';
export const COLECAO_PEDIDOS = 'pedidosDeLoja';

// O app mostra a tela E5: "Este e-mail já tem cadastro. Entrar".
function emailJaUsado() {
  return new AppError('Este e-mail já tem cadastro. Entre com ele.', {
    statusCode: 409,
    code: 'cadastro_email_em_uso',
    details: { campo: 'email' },
  });
}

// O app mostra a tela E10 no passo do CNPJ: "Este CNPJ já tem cadastro na Móbile.", com
// "Recuperar conta" e o WhatsApp. Nao devolve nenhum dado da conta, loja ou pedido existente.
function cnpjJaCadastrado() {
  return new AppError('Este CNPJ já tem cadastro na Móbile.', {
    statusCode: 409,
    code: 'cnpj_ja_cadastrado',
    details: { campo: 'cnpj' },
  });
}

function enderecoCompleto(endereco = {}) {
  const rua = [endereco.street, endereco.number].filter(Boolean).join(', ');
  return [rua, endereco.neighborhood, [endereco.city, endereco.uf].filter(Boolean).join(' - ')]
    .filter(Boolean).join(', ') || null;
}

export class CadastroDeLoja {
  constructor({
    firestore,
    auth,
    consultaCnpj,
    limites = null,
    imagens = null,
    serverTimestamp = () => FieldValue.serverTimestamp(),
    pontoNoMapa = (lat, lng) => new GeoPoint(lat, lng),
    jornada = null,
  }) {
    this.jornada = jornada;
    this.firestore = firestore;
    this.auth = auth;
    this.consultaCnpj = consultaCnpj;
    this.limites = limites;
    this.imagens = imagens;
    this.serverTimestamp = serverTimestamp;
    this.pontoNoMapa = pontoNoMapa;
  }

  // CNPJ que ja tem cadastro e recusado (decisao do Thay de 27/10/2026, que desfaz a de 16/10 de
  // criar a conta mesmo assim): a consulta do passo do CNPJ e a criacao respondem 409
  // cnpj_ja_cadastrado. "Ja tem cadastro" e o mesmo criterio do antigo cnpjRepetido: alguma loja
  // em estabelecimentos ou algum pedido em pedidosDeLoja com o CNPJ, em qualquer situacao
  // (recusados inclusive). Lojas antigas guardam o CNPJ formatado em cpfOrCnpj (ou cpfOrCpnf);
  // as novas, so os digitos em cnpj.
  async lojasComOCnpj(cnpj) {
    const lojas = this.firestore.collection('estabelecimentos');
    const consultas = [
      lojas.where('cnpj', '==', cnpj),
      lojas.where('cpfOrCnpj', '==', formatarCnpj(cnpj)),
      lojas.where('cpfOrCnpj', '==', cnpj),
      lojas.where('cpfOrCpnf', '==', formatarCnpj(cnpj)),
    ];
    const resultados = await Promise.all(consultas.map((consulta) => consulta.limit(5).get()));
    return [...new Set(resultados.flatMap((resultado) => resultado.docs.map((documento) => documento.id)))].slice(0, 5);
  }

  // Pedidos de loja (que ainda nao viraram loja) com o mesmo CNPJ.
  async pedidosComOCnpj(cnpj) {
    const resultado = await this.firestore.collection(COLECAO_PEDIDOS).where('cnpj', '==', cnpj).limit(5).get();
    return resultado.docs.map((documento) => documento.id);
  }

  async assertCnpjLivre(cnpj) {
    const [lojas, pedidos] = await Promise.all([this.lojasComOCnpj(cnpj), this.pedidosComOCnpj(cnpj)]);
    if (lojas.length > 0 || pedidos.length > 0) throw cnpjJaCadastrado();
  }

  async assertEmailLivre(email) {
    try {
      await this.auth.getUserByEmail(email);
    } catch (error) {
      if (error?.code === 'auth/user-not-found') return;
      throw error;
    }
    throw emailJaUsado();
  }

  // Receita, sem bloqueio (estados E1 inativo e E2 sem resposta da especificacao): o app mostra
  // o card de cada caso e segue. cnpjConferido e true quando a Receita respondeu, ativo ou nao.
  async conferirCnpj(cnpj) {
    const empresa = await this.consultaCnpj.consultar(cnpj);
    if (!empresa) {
      return {
        cnpjConferido: false, encontrado: null, ativa: null, situacao: null, razaoSocial: null, nomeFantasia: null, endereco: null,
      };
    }
    if (!empresa.encontrado) {
      return {
        cnpjConferido: true, encontrado: false, ativa: false, situacao: null, razaoSocial: null, nomeFantasia: null, endereco: null,
      };
    }
    return {
      cnpjConferido: true,
      encontrado: true,
      ativa: empresa.ativa === true,
      situacao: empresa.situacao || null,
      razaoSocial: empresa.razaoSocial || null,
      nomeFantasia: empresa.nomeFantasia || null,
      endereco: empresa.endereco || null,
    };
  }

  // Consulta usada pela tela do CNPJ do app, antes de criar a conta: mostra a razao social,
  // o nome fantasia e o endereco encontrados. CNPJ que ja tem cadastro recebe o 409 (E10), depois
  // de contar a tentativa e antes de consultar a Receita.
  async consultarCnpj(cnpjInformado, { ip = null } = {}) {
    const digitos = validarCnpj(cnpjInformado);
    await this.limites?.registrar([{ tipo: 'ip', valor: ip }, { tipo: 'cnpj', valor: digitos }]);
    await this.assertCnpjLivre(digitos);
    const conferencia = await this.conferirCnpj(digitos);
    return { cnpj: digitos, ...conferencia };
  }

  async criar(entrada, { ip = null } = {}) {
    const pedido = validarPedidoDeCadastro(entrada);
    await this.limites?.registrar([
      { tipo: 'ip', valor: ip },
      { tipo: 'cnpj', valor: pedido.cnpj },
      { tipo: 'email', valor: pedido.responsavel.email },
    ]);
    await this.assertEmailLivre(pedido.responsavel.email);
    await this.assertCnpjLivre(pedido.cnpj);
    const receita = await this.conferirCnpj(pedido.cnpj);
    const { cnpjConferido, razaoSocial } = receita;

    let conta;
    try {
      conta = await this.auth.createUser({
        email: pedido.responsavel.email,
        password: pedido.senha,
        displayName: pedido.responsavel.nome,
        emailVerified: false,
        disabled: false,
      });
    } catch (error) {
      if (error?.code === 'auth/email-already-exists') throw emailJaUsado();
      throw error;
    }

    const uid = conta.uid;
    const usuarioRef = this.firestore.collection('Users').doc(uid);
    const pedidoRef = this.firestore.collection(COLECAO_PEDIDOS).doc();
    const agora = this.serverTimestamp();
    // Endereco confirmado no mapa, no formato das lojas que ja existem (address.position e o
    // GeoPoint do pino). O endereco da Receita fica a parte, para o Admin comparar.
    const { endereco } = pedido;
    const camposDoEndereco = {
      street: endereco.rua,
      number: endereco.numero,
      complement: endereco.complemento,
      neighborhood: endereco.bairro,
      city: endereco.cidade,
      uf: endereco.uf,
      state: endereco.uf,
      zipCode: endereco.cep,
      reference: endereco.referencia,
    };
    const address = {
      ...camposDoEndereco,
      position: this.pontoNoMapa(endereco.lat, endereco.lng),
      fullAddress: enderecoCompleto(camposDoEndereco),
      createAt: agora,
      updateAt: agora,
    };
    const usuario = {
      id: uid,
      userAuthId: uid,
      userType: 'UserType.empresa',
      whitelabelId: WHITELABEL_GERENCIADOR,
      name: pedido.responsavel.nome,
      email: pedido.responsavel.email,
      phone: pedido.responsavel.celular,
      profileImage: null,
      verified: false,
      // Id do pedido de loja: a loja so existe depois do "Aprovar" do Admin.
      pedidoDeLojaId: pedidoRef.id,
      createdAt: agora,
    };
    try {
      const lote = this.firestore.batch();
      // Users/{uid}: o id do documento e o uid. O campo id repete o id do documento, como o app
      // gerenciador espera (ele acha a loja por userReference = Users/{id}).
      lote.create(usuarioRef, usuario);
      // O pedido leva os mesmos dados que o cadastro gravava na loja; o Admin os copia para
      // estabelecimentos no "Aprovar" (PedidosDeLoja.lojaDoPedido).
      lote.create(pedidoRef, {
        id: pedidoRef.id,
        uid,
        lojaId: null,
        name: pedido.nome,
        razaoSocial: razaoSocial || null,
        corporateName: razaoSocial || null,
        nomeFantasia: receita.nomeFantasia,
        cnpj: pedido.cnpj,
        cpfOrCnpj: formatarCnpj(pedido.cnpj),
        cnpjConferido,
        cnpjAtivo: receita.ativa,
        cnpjSituacao: receita.situacao,
        // Desde 27/10/2026 o CNPJ repetido nao chega aqui; os campos ficam, vazios, no formato
        // que o Admin le (PedidosDeLoja).
        cnpjRepetido: false,
        lojasComOMesmoCnpj: [],
        pedidosComOMesmoCnpj: [],
        enderecoReceita: receita.endereco,
        address,
        erp: pedido.erp,
        instalacaoId: pedido.instalacaoId,
        phone: pedido.responsavel.celular,
        email: pedido.responsavel.email,
        responsibleName: pedido.responsavel.nome,
        status: STATUS.AGUARDANDO_EMAIL,
        origemCadastro: ORIGEM_APP_GERENCIADOR,
        userReference: usuarioRef,
        createdAt: agora,
        updatedAt: agora,
      });
      await lote.commit();
    } catch (error) {
      try {
        await this.auth.deleteUser(uid);
      } catch (desfazer) {
        logger.error('cadastro_conta_solta', { uid, originalMessage: desfazer?.message });
      }
      throw error;
    }

    // A instalacao do app vira "concluido" com o id do pedido (o da loja entra na aprovacao).
    // Falha aqui nao desfaz o pedido: o funil perde uma marca, o pedido e a conta ficam.
    try {
      await this.jornada?.concluir(pedido.instalacaoId, pedidoRef.id);
    } catch (error) {
      logger.error('cadastro_jornada_nao_concluida', { pedidoId: pedidoRef.id, originalMessage: error?.message });
    }

    // cnpjRepetido fica na resposta (sempre false) para o app que ainda le o campo.
    return { uid, pedidoId: pedidoRef.id, status: STATUS.AGUARDANDO_EMAIL, cnpjConferido, cnpjRepetido: false };
  }

  // Pedido de loja do dono que esta logado: o id gravado em Users/{uid}.pedidoDeLojaId ou, sem
  // ele, o pedido com userReference = Users/{uid}.
  async pedidoDoDono(uid) {
    if (!uid) {
      throw new AppError('Login obrigatório.', { statusCode: 401, code: 'auth_token_required' });
    }
    const usuarioRef = this.firestore.collection('Users').doc(uid);
    const usuario = await usuarioRef.get();
    const pedidoId = usuario.exists ? usuario.data()?.pedidoDeLojaId : null;
    if (pedidoId) {
      const pedido = await this.firestore.collection(COLECAO_PEDIDOS).doc(pedidoId).get();
      if (pedido.exists) return pedido;
    }
    const snapshot = await this.firestore.collection(COLECAO_PEDIDOS).where('userReference', '==', usuarioRef).limit(1).get();
    if (snapshot.empty) {
      throw new AppError('Não achamos o pedido de loja desta conta.', { statusCode: 404, code: 'cadastro_pedido_nao_encontrado' });
    }
    return snapshot.docs[0];
  }

  // Loja do dono que esta logado: a que tem userReference = Users/{uid}. So a troca de logo e
  // fachada do cadastro (/loja/imagens/:tipo) ainda usa; logo e fachada sairam do cadastro.
  async lojaDoDono(uid) {
    if (!uid) {
      throw new AppError('Login obrigatório.', { statusCode: 401, code: 'auth_token_required' });
    }
    const usuarioRef = this.firestore.collection('Users').doc(uid);
    const snapshot = await this.firestore.collection('estabelecimentos').where('userReference', '==', usuarioRef).limit(1).get();
    if (snapshot.empty) {
      throw new AppError('Não achamos o pedido de loja desta conta.', { statusCode: 404, code: 'cadastro_pedido_nao_encontrado' });
    }
    return snapshot.docs[0];
  }

  // O app manda o e-mail de confirmacao (sendEmailVerification); aqui so entra conta confirmada.
  async enviarPedido(uid) {
    const usuario = await this.auth.getUser(uid);
    if (!usuario?.emailVerified) {
      throw new AppError('Confirme o e-mail pelo link que enviamos antes de mandar o pedido.', {
        statusCode: 403,
        code: 'cadastro_email_nao_confirmado',
      });
    }
    const pedido = await this.pedidoDoDono(uid);
    const status = pedido.data()?.status;
    if (status !== STATUS.AGUARDANDO_EMAIL) {
      if (status === STATUS.EM_ANALISE || status === STATUS.EM_CONVERSA) return this.situacao(uid);
      throw new AppError('Este pedido já foi decidido.', { statusCode: 409, code: 'cadastro_pedido_decidido' });
    }
    await pedido.ref.update({ status: STATUS.EM_ANALISE, enviadoEm: this.serverTimestamp(), updatedAt: this.serverTimestamp() });
    return this.situacao(uid);
  }

  // O que o app mostra nas telas 6, E6, E7 e "aprovado". lojaId so existe depois do "Aprovar".
  async situacao(uid) {
    const [pedido, usuario] = await Promise.all([this.pedidoDoDono(uid), this.auth.getUser(uid)]);
    const dados = pedido.data() || {};
    const aprovado = dados.status === STATUS.APROVADA;
    return {
      pedidoId: pedido.id,
      status: dados.status || null,
      situacao: situacaoParaOApp(dados.status),
      motivo: dados.status === STATUS.RECUSADA ? dados.motivoRecusa || null : null,
      lojaId: aprovado ? dados.lojaId || null : null,
      nomeDaLoja: dados.name || null,
      emailConfirmado: Boolean(usuario?.emailVerified),
      enviadoEm: paraIso(dados.enviadoEm),
      aprovadoEm: paraIso(dados.aprovadoEm),
    };
  }

  // Logo e fachada do cadastro: so o dono, so na propria loja e so antes da decisao.
  async trocarImagem(uid, tipo, conteudo) {
    if (!['logo', 'fachada'].includes(tipo)) {
      throw new AppError('No cadastro, envie o logo ou a foto da fachada.', { statusCode: 400, code: 'imagem_tipo_invalido' });
    }
    const loja = await this.lojaDoDono(uid);
    if (!STATUS_DO_CADASTRO.includes(loja.data()?.status)) {
      throw new AppError('As imagens do cadastro só mudam enquanto o pedido está em análise.', {
        statusCode: 403,
        code: 'cadastro_imagem_fora_do_prazo',
      });
    }
    return this.imagens.trocar(loja.id, tipo, conteudo, { updatedAt: this.serverTimestamp() });
  }
}

// O que o app mostra: em analise, aprovado ou recusado (mais o passo do e-mail).
export function situacaoParaOApp(status) {
  if (status === STATUS.APROVADA) return 'aprovado';
  if (status === STATUS.RECUSADA) return 'recusado';
  if (status === STATUS.AGUARDANDO_EMAIL) return 'aguardando_email';
  return 'em_analise';
}

function paraIso(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate().toISOString();
  if (valor instanceof Date) return valor.toISOString();
  return null;
}
