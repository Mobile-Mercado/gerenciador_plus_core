import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import { quandoIso } from './PedidosDeLoja.js';

// Franquias (Admin, rodada de 13/10/2026): lista e edita o que existe na colecao franquias.
// Editaveis so nomeFranquia, nomeFranqueado e a cidade (cidadeValue). Banco, transferencia,
// tipo da conta e o recebedor do Pagar.me (recebedorData) ficam so para leitura, com CPF e conta
// mascarados: mudar aqui descasaria do recebedor. Nada de criar recebedor nem pagamento.
const EDITAVEIS = ['nomeFranquia', 'nomeFranqueado', 'cidadeValue'];

export function mascarar(valor, visiveis = 2) {
  const texto = String(valor ?? '').replace(/\s/g, '');
  if (!texto) return null;
  if (texto.length <= visiveis) return '•'.repeat(texto.length);
  return `${'•'.repeat(texto.length - visiveis)}${texto.slice(-visiveis)}`;
}

function linhaDaFranquia(documento, lojasPorFranquia) {
  const data = documento.data() || {};
  const recebedor = data.recebedorData || {};
  return {
    id: documento.id,
    nomeFranquia: data.nomeFranquia || null,
    nomeFranqueado: data.nomeFranqueado || null,
    cidadeValue: data.cidadeValue || null,
    lojas: lojasPorFranquia.get(documento.id) || 0,
    criadaEm: quandoIso(data.createdAt),
    atualizadaEm: quandoIso(data.updatedAt),
    soLeitura: {
      cpf: mascarar(data.cpf, 2),
      tipoConta: data.tipo || null,
      codigoBanco: data.codigoBanco || null,
      agencia: mascarar(data.agencia, 1),
      conta: mascarar(data.conta, 2),
      intervaloTransferencia: data.intervaloTransferencia || null,
      diaTransferencia: data.diaTransferencia ?? null,
      recebedor: {
        id: mascarar(recebedor.id, 4),
        status: recebedor.status || null,
        transferenciaLigada: recebedor.transfer_enabled ?? null,
        intervalo: recebedor.transfer_interval || null,
      },
    },
  };
}

export class Franquias {
  constructor({ firestore }) {
    this.firestore = firestore;
  }

  async listar() {
    const [franquias, lojas] = await Promise.all([
      this.firestore.collection('franquias').get(),
      this.firestore.collection('estabelecimentos').select('franquiaId').get(),
    ]);
    const lojasPorFranquia = new Map();
    lojas.docs.forEach((documento) => {
      const id = documento.data()?.franquiaId;
      if (id) lojasPorFranquia.set(id, (lojasPorFranquia.get(id) || 0) + 1);
    });
    return franquias.docs.map((documento) => linhaDaFranquia(documento, lojasPorFranquia))
      .sort((a, b) => String(a.nomeFranquia).localeCompare(String(b.nomeFranquia), 'pt-BR'));
  }

  async editar(id, entrada = {}) {
    const referencia = this.firestore.collection('franquias').doc(String(id || ''));
    const atual = await referencia.get();
    if (!atual.exists) throw new AppError('Franquia não encontrada.', { statusCode: 404, code: 'franquia_nao_encontrada' });
    const recusados = Object.keys(entrada).filter((campo) => !EDITAVEIS.includes(campo));
    if (recusados.length) {
      throw new AppError('Só nome da franquia, nome do franqueado e cidade mudam por aqui.', {
        statusCode: 400,
        code: 'franquia_campo_so_leitura',
        details: { campos: recusados },
      });
    }
    const atualizacao = {};
    const antes = {};
    EDITAVEIS.forEach((campo) => {
      if (entrada[campo] === undefined) return;
      const valor = String(entrada[campo] ?? '').replace(/\s+/g, ' ').trim();
      if (valor.length < 2 || valor.length > 120) {
        throw new AppError('Preencha com 2 a 120 caracteres.', { statusCode: 400, code: 'franquia_campo_invalido', details: { campo } });
      }
      if (valor !== atual.data()?.[campo]) {
        atualizacao[campo] = valor;
        antes[campo] = atual.data()?.[campo] ?? null;
      }
    });
    if (Object.keys(atualizacao).length) {
      // callOnWrite: o gatilho da franquia refaz o indice de busca com o nome novo.
      await referencia.update({ ...atualizacao, callOnWrite: true, updatedAt: FieldValue.serverTimestamp() });
    }
    return { id: referencia.id, antes, depois: atualizacao };
  }
}
