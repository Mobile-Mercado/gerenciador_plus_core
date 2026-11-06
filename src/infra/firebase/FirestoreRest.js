import { applicationDefault } from 'firebase-admin/app';
import { AppError } from '../../domain/errors/AppError.js';

// Firestore pela API REST, com a credencial do proprio Core (a mesma do Admin SDK). Usado onde o tipo
// do campo precisa ser explicito, como o doubleValue do tamanho do banner. Com FIRESTORE_EMULATOR_HOST,
// fala com o emulador.
export class FirestoreRest {
  constructor({
    projectId,
    fetchImpl = globalThis.fetch,
    emulador = process.env.FIRESTORE_EMULATOR_HOST || '',
    token = async () => (await applicationDefault().getAccessToken()).access_token,
  }) {
    this.projectId = projectId;
    this.fetch = fetchImpl;
    this.base = emulador
      ? `http://${emulador}/v1/projects/${projectId}/databases/(default)/documents`
      : `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    this.token = emulador ? async () => 'owner' : token;
  }

  async cabecalhos() {
    return { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' };
  }

  // criar: o documento nao pode existir; mascara: so esses campos mudam (os outros ficam).
  async gravar(caminho, documento, { criar = false, mascara = null } = {}) {
    const parametros = new URLSearchParams();
    if (criar) parametros.set('currentDocument.exists', 'false');
    else parametros.set('currentDocument.exists', 'true');
    (mascara || []).forEach((campo) => parametros.append('updateMask.fieldPaths', campo));
    const resposta = await this.fetch(`${this.base}/${caminho}?${parametros}`, {
      method: 'PATCH',
      headers: await this.cabecalhos(),
      body: JSON.stringify(documento),
    });
    if (!resposta.ok) {
      throw new AppError('Não foi possível gravar o banner.', {
        statusCode: 502,
        code: 'firestore_rest_falhou',
        details: { status: resposta.status, motivo: (await resposta.text()).slice(0, 300) },
      });
    }
    return resposta.json();
  }

  async ler(caminho) {
    const resposta = await this.fetch(`${this.base}/${caminho}`, { headers: await this.cabecalhos() });
    if (resposta.status === 404) return null;
    if (!resposta.ok) {
      throw new AppError('Não foi possível ler o banner.', { statusCode: 502, code: 'firestore_rest_falhou' });
    }
    return resposta.json();
  }
}
