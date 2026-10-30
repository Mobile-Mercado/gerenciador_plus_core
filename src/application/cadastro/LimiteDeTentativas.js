import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';

// Limite de tentativas do cadastro publico, contado no Firestore para valer entre as
// instancias do Cloud Run: limitesCadastro/{chave} = { contagem, janelaInicio, expiraEm }.
// A chave guarda so o hash do IP, do CNPJ ou do e-mail. O campo expiraEm e o da politica
// de expiracao (TTL) que o Thay cria no console depois da publicacao.
export const LIMITES = Object.freeze({
  ip: { maximo: 5, janelaMs: 24 * 60 * 60 * 1000 },
  cnpj: { maximo: 5, janelaMs: 24 * 60 * 60 * 1000 },
  email: { maximo: 5, janelaMs: 24 * 60 * 60 * 1000 },
  // Jornada do cadastro (eventos e rascunhos, por IP): conta separada da do cadastro, porque o
  // app manda uma abertura a cada vez que abre, logado ou nao.
  jornada: { maximo: 300, janelaMs: 24 * 60 * 60 * 1000 },
});

export function chaveDoLimite(tipo, valor) {
  const hash = createHash('sha256').update(`${tipo}:${String(valor ?? '').trim().toLowerCase()}`).digest('hex');
  return `${tipo}_${hash.slice(0, 40)}`;
}

export class LimiteDeTentativas {
  constructor({ firestore, clock = () => Date.now(), paraData = (ms) => Timestamp.fromMillis(ms) }) {
    this.firestore = firestore;
    this.clock = clock;
    this.paraData = paraData;
  }

  // Conta uma tentativa em cada chave; acima do maximo de alguma, recusa sem contar nas outras.
  async registrar(itens = []) {
    const agora = this.clock();
    const referencias = itens
      .filter(({ valor }) => valor)
      .map(({ tipo, valor }) => ({ tipo, ref: this.firestore.collection('limitesCadastro').doc(chaveDoLimite(tipo, valor)) }));
    if (!referencias.length) return;
    await this.firestore.runTransaction(async (transacao) => {
      const atuais = await Promise.all(referencias.map(({ ref }) => transacao.get(ref)));
      const novos = referencias.map(({ tipo, ref }, indice) => {
        const { maximo, janelaMs } = LIMITES[tipo];
        const dados = atuais[indice].exists ? atuais[indice].data() : null;
        const inicio = Number(dados?.janelaInicio) || 0;
        const dentro = dados && agora - inicio < janelaMs;
        const contagem = dentro ? Number(dados.contagem) || 0 : 0;
        if (contagem >= maximo) {
          throw new AppError('Muitas tentativas de cadastro. Tente de novo mais tarde.', {
            statusCode: 429,
            code: 'cadastro_tentativas_excedidas',
            details: { limite: tipo },
          });
        }
        const janelaInicio = dentro ? inicio : agora;
        return { ref, dados: { tipo, contagem: contagem + 1, janelaInicio, expiraEm: this.paraData(janelaInicio + janelaMs) } };
      });
      novos.forEach(({ ref, dados }) => transacao.set(ref, dados));
    });
  }
}
