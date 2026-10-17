import { FieldValue, GeoPoint } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { formatarCnpj, validarCnpj, validarPedidoDeCadastro } from '../../domain/cadastro/validacoes.js';
import { logger } from '../../infra/logger/logger.js';

// Cadastro de loja feito pelo servidor (rodada de 13/10/2026). O app gerenciador manda o pedido
// e o Core cria, numa operacao so, a conta no Auth, Users/{uid} e estabelecimentos/{novoId}. Se
// a gravacao no Firestore falhar, a conta criada e apagada: nao fica conta solta. Nada recebe
// claim aqui; a claim vem na aprovacao, pelo Admin.
//
// Situacoes do pedido (campo status da loja):
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

// O app mostra a tela E5: "Este e-mail já tem cadastro. Entrar".
function emailJaUsado() {
  return new AppError('Este e-mail já tem cadastro. Entre com ele.', {
    statusCode: 409,
    code: 'cadastro_email_em_uso',
    details: { campo: 'email' },
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

  // CNPJ repetido nao bloqueia mais o cadastro (ordem nova de 16/10/2026): devolve as lojas e
  // pedidos com o mesmo CNPJ, recusados inclusive, para o pedido guardar cnpjRepetido e o Admin
  // ver. Lojas antigas guardam o CNPJ formatado em cpfOrCnpj (ou cpfOrCpnf); as novas, so os
  // digitos em cnpj.
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
  // o nome fantasia e o endereco encontrados. Nao diz se o CNPJ ja tem loja.
  async consultarCnpj(cnpjInformado, { ip = null } = {}) {
    const digitos = validarCnpj(cnpjInformado);
    await this.limites?.registrar([{ tipo: 'ip', valor: ip }, { tipo: 'cnpj', valor: digitos }]);
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
    const [lojasRepetidas, receita] = await Promise.all([
      this.lojasComOCnpj(pedido.cnpj),
      this.conferirCnpj(pedido.cnpj),
    ]);
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
    const lojaRef = this.firestore.collection('estabelecimentos').doc();
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
      createdAt: agora,
    };
    try {
      const lote = this.firestore.batch();
      // Users/{uid}: o id do documento e o uid. O campo id repete o id do documento, como o app
      // gerenciador espera (ele acha a loja por userReference = Users/{id}).
      lote.create(usuarioRef, usuario);
      lote.create(lojaRef, {
        id: lojaRef.id,
        name: pedido.nome,
        razaoSocial: razaoSocial || null,
        corporateName: razaoSocial || null,
        nomeFantasia: receita.nomeFantasia,
        cnpj: pedido.cnpj,
        cpfOrCnpj: formatarCnpj(pedido.cnpj),
        cnpjConferido,
        cnpjAtivo: receita.ativa,
        cnpjSituacao: receita.situacao,
        cnpjRepetido: lojasRepetidas.length > 0,
        lojasComOMesmoCnpj: lojasRepetidas,
        enderecoReceita: receita.endereco,
        address,
        erp: pedido.erp,
        instalacaoId: pedido.instalacaoId,
        phone: pedido.responsavel.celular,
        email: pedido.responsavel.email,
        responsibleName: pedido.responsavel.nome,
        isActive: false,
        userType: 'UserType.noneEmpresa',
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

    // A instalacao do app vira "concluido" com o id da loja. Falha aqui nao desfaz o pedido: o
    // funil perde uma marca, a loja e a conta ficam.
    try {
      await this.jornada?.concluir(pedido.instalacaoId, lojaRef.id);
    } catch (error) {
      logger.error('cadastro_jornada_nao_concluida', { lojaId: lojaRef.id, originalMessage: error?.message });
    }

    return { uid, lojaId: lojaRef.id, status: STATUS.AGUARDANDO_EMAIL, cnpjConferido, cnpjRepetido: lojasRepetidas.length > 0 };
  }

  // Loja do dono que esta logado: a que tem userReference = Users/{uid}.
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
    const loja = await this.lojaDoDono(uid);
    const status = loja.data()?.status;
    if (status !== STATUS.AGUARDANDO_EMAIL) {
      if (status === STATUS.EM_ANALISE || status === STATUS.EM_CONVERSA) return this.situacao(uid);
      throw new AppError('Este pedido já foi decidido.', { statusCode: 409, code: 'cadastro_pedido_decidido' });
    }
    await loja.ref.update({ status: STATUS.EM_ANALISE, enviadoEm: this.serverTimestamp(), updatedAt: this.serverTimestamp() });
    return this.situacao(uid);
  }

  async situacao(uid) {
    const [loja, usuario] = await Promise.all([this.lojaDoDono(uid), this.auth.getUser(uid)]);
    const dados = loja.data() || {};
    return {
      lojaId: loja.id,
      status: dados.status || null,
      situacao: situacaoParaOApp(dados.status),
      motivoRecusa: dados.status === STATUS.RECUSADA ? dados.motivoRecusa || null : null,
      emailConfirmado: Boolean(usuario?.emailVerified),
      enviadoEm: paraIso(dados.enviadoEm),
      aprovadoEm: paraIso(dados.aprovadoEm),
      temLogo: Boolean(dados.chatProfileImageUrl),
      temFachada: Boolean(dados.coverImageUrl),
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
