import { AppError } from '../../domain/errors/AppError.js';
import productImageFileCheck from '../../../functions/productImageFileCheck.js';
import instalacoesApp from '../../../functions/instalacoesApp.js';

// Tela "Instalacoes" do Admin da plataforma (16/10/2026). A montagem dos documentos
// Stats/instalacoesApp mora em functions/instalacoesApp.js, num arquivo puro que os dois lados usam:
// a rotina semanal instalacoesAppNightly e o botao "Atualizar agora" desta tela.
const { configuredEstablishmentIds } = productImageFileCheck;
const { INSTALACOES_DOCUMENT, atualizarTodasAsLojas, doisUltimosMeses, lojasComApp } = instalacoesApp;

// As lojas com app sao as mesmas da rotina: as de CoreJobs/verifyProductImageFiles cujo whitelabelId
// tem app no mapa APPS_POR_WHITELABEL.
const CONFIG_DAS_LOJAS = 'CoreJobs/verifyProductImageFiles';
// Um clique por vez, em todas as instancias do Core: a trava fica neste documento. Vence em 15
// minutos, para uma execucao que caiu no meio nao travar o botao para sempre.
const TRAVA = 'CoreJobs/instalacoesAppAtualizacao';
const TRAVA_VENCE_MS = 15 * 60 * 1000;

function paraIso(valor) {
  if (!valor) return null;
  if (typeof valor.toDate === 'function') return valor.toDate().toISOString();
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

export class InstalacoesDosApps {
  // fontes: async () => ({ bucket, apple }), com a conta de servico relatorios-lojas e a chave da Apple.
  constructor({ firestore, FieldValue, fontes, agora = () => Date.now() }) {
    this.firestore = firestore;
    this.FieldValue = FieldValue;
    this.fontes = fontes;
    this.agora = agora;
  }

  async lojaIds() {
    const config = await this.firestore.doc(CONFIG_DAS_LOJAS).get();
    return configuredEstablishmentIds(config.exists ? config.data() : null);
  }

  // Uma leitura do Stats/instalacoesApp por loja com app, quando a tela abre.
  async listar() {
    const { comApp } = await lojasComApp({ db: this.firestore, lojaIds: await this.lojaIds() });
    const referencias = comApp.map((loja) => this.firestore
      .collection('estabelecimentos').doc(loja.id).collection('Stats').doc(INSTALACOES_DOCUMENT));
    const documentos = referencias.length ? await this.firestore.getAll(...referencias) : [];
    return {
      lojas: comApp.map((loja, indice) => {
        const dados = documentos[indice]?.exists ? documentos[indice].data() : null;
        return {
          id: loja.id,
          nome: loja.nome,
          android: loja.apps.android,
          ios: loja.apps.ios,
          documento: dados ? { ...dados, atualizadoEm: paraIso(dados.atualizadoEm) } : null,
        };
      }),
    };
  }

  async travar() {
    const referencia = this.firestore.doc(TRAVA);
    const agora = this.agora();
    await this.firestore.runTransaction(async (transacao) => {
      const atual = await transacao.get(referencia);
      const desde = Number(atual.exists ? atual.data()?.rodandoDesde : 0) || 0;
      if (desde && agora - desde < TRAVA_VENCE_MS) {
        throw new AppError('Já está atualizando. Aguarde terminar.', { statusCode: 409, code: 'instalacoes_atualizando' });
      }
      transacao.set(referencia, { rodandoDesde: agora }, { merge: true });
    });
  }

  async destravar() {
    await this.firestore.doc(TRAVA).set({ rodandoDesde: null, terminouEm: this.agora() }, { merge: true });
  }

  // "Atualizar agora": a mesma montagem da rotina, para todas as lojas com app, gravando os documentos.
  async atualizar() {
    await this.travar();
    try {
      const { bucket, apple } = await this.fontes();
      const relatorio = await atualizarTodasAsLojas({
        db: this.firestore,
        FieldValue: this.FieldValue,
        lojaIds: await this.lojaIds(),
        bucket,
        apple,
        meses: doisUltimosMeses(new Date(this.agora())),
      });
      return { lojas: relatorio };
    } finally {
      await this.destravar();
    }
  }
}
