import { FieldValue } from 'firebase-admin/firestore';
import { validarCelular } from '../../domain/cadastro/validacoes.js';
import { AppError } from '../../domain/errors/AppError.js';

// Entregadores da loja com o celular (decisao do Thay de 17/10/2026). O celular nao fica no
// documento da loja nem no pedido, porque as regras publicadas deixam qualquer conta logada ler
// os dois. Fica em estabelecimentos/{loja}/entregadoresPrivado/{id} = { name, phone, createdAt,
// updatedAt }, que so o Core le e grava (nenhuma regra do Firestore libera essa subcolecao).
// deliveryMenList continua so com os nomes, para quem ja le a lista.
export const COLECAO_ENTREGADORES = 'entregadoresPrivado';
export const MAXIMO_DE_ENTREGADORES = 50;

const NOME = /^[\p{L}\p{N} .'\-]+$/u;

function recusa(mensagem, code, details) {
  return new AppError(mensagem, { statusCode: 400, code, details });
}

const chaveDoNome = (nome) => nome.toLocaleLowerCase('pt-BR');

// Lista inteira, como a tela manda: nome obrigatorio (sem repetir) e celular opcional com DDD.
export function validarEntregadores(lista) {
  if (!Array.isArray(lista)) throw recusa('Envie a lista de entregadores.', 'entregadores_lista_invalida');
  if (lista.length > MAXIMO_DE_ENTREGADORES) {
    throw recusa(`A loja pode ter até ${MAXIMO_DE_ENTREGADORES} entregadores.`, 'entregadores_lista_invalida');
  }
  const vistos = new Set();
  return lista.map((item, indice) => {
    const name = String(item?.name ?? '').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60 || !NOME.test(name)) {
      throw recusa('Escreva o nome do entregador com 2 a 60 letras.', 'entregador_nome_invalido', { indice });
    }
    if (vistos.has(chaveDoNome(name))) throw recusa(`O entregador ${name} está repetido.`, 'entregador_repetido', { indice });
    vistos.add(chaveDoNome(name));
    const digitos = String(item?.phone ?? '').replace(/\D/g, '');
    let phone = null;
    if (digitos) {
      try {
        phone = validarCelular(digitos);
      } catch {
        throw recusa('Celular do entregador inválido. Use o DDD e os 9 números.', 'entregador_celular_invalido', { indice });
      }
    }
    return { name, phone };
  });
}

export class EntregadoresDaLoja {
  constructor({ firestore, serverTimestamp = () => FieldValue.serverTimestamp() }) {
    this.firestore = firestore;
    this.serverTimestamp = serverTimestamp;
  }

  lojaRef(lojaId) {
    return this.firestore.collection('estabelecimentos').doc(String(lojaId || ''));
  }

  // [{ id, name, phone }], por nome. Nome que esta so no deliveryMenList (lista antiga, antes desta
  // rota) entra com id e phone null, para a tela mostrar quem a loja ja tinha.
  async listar(lojaId) {
    const loja = this.lojaRef(lojaId);
    const [documentos, dadosDaLoja] = await Promise.all([loja.collection(COLECAO_ENTREGADORES).get(), loja.get()]);
    const lista = documentos.docs.map((documento) => ({
      id: documento.id, name: documento.data()?.name || '', phone: documento.data()?.phone || null,
    }));
    const nomes = new Set(lista.map((item) => chaveDoNome(item.name)));
    const antigos = Array.isArray(dadosDaLoja.data()?.deliveryMenList) ? dadosDaLoja.data().deliveryMenList : [];
    antigos
      .map((item) => String(typeof item === 'string' ? item : item?.name || '').replace(/\s+/g, ' ').trim())
      .filter((nome) => nome && !nomes.has(chaveDoNome(nome)))
      .forEach((nome) => { nomes.add(chaveDoNome(nome)); lista.push({ id: null, name: nome, phone: null }); });
    return lista.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  // Grava a lista inteira numa operacao so: entregador que saiu e apagado, o que ficou (pelo
  // nome) mantem o id e o createdAt, o novo ganha id; e deliveryMenList so com os nomes.
  async salvar(lojaId, entrada) {
    const lista = validarEntregadores(entrada);
    const loja = this.lojaRef(lojaId);
    const [atual, documentos] = await Promise.all([loja.get(), loja.collection(COLECAO_ENTREGADORES).get()]);
    if (!atual.exists) throw new AppError('Loja não encontrada.', { statusCode: 404, code: 'loja_nao_encontrada' });
    const porNome = new Map(documentos.docs.map((documento) => [chaveDoNome(String(documento.data()?.name || '')), documento]));
    const agora = this.serverTimestamp();
    const lote = this.firestore.batch();
    const mantidos = new Set();
    lista.forEach(({ name, phone }) => {
      const existente = porNome.get(chaveDoNome(name));
      if (existente) {
        mantidos.add(existente.id);
        lote.set(existente.ref, { name, phone, updatedAt: agora }, { merge: true });
      } else {
        lote.set(loja.collection(COLECAO_ENTREGADORES).doc(), { name, phone, createdAt: agora, updatedAt: agora });
      }
    });
    documentos.docs.filter((documento) => !mantidos.has(documento.id)).forEach((documento) => lote.delete(documento.ref));
    lote.update(loja, { deliveryMenList: lista.map(({ name }) => name), updatedAt: agora });
    await lote.commit();
    return this.listar(lojaId);
  }
}
