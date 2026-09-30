import { FieldValue } from 'firebase-admin/firestore';
import { AppError } from '../../domain/errors/AppError.js';
import categoriasContagem from '../../../functions/categoriasContagem.js';

// A contagem mora em functions/categoriasContagem.js, num arquivo puro que os dois
// lados importam: a varredura noturna e esta rota.
export class RecalculateCategoryCountsUseCase {
  constructor({ firestore, accessRepository, counter = categoriasContagem }) {
    this.firestore = firestore;
    this.accessRepository = accessRepository;
    this.counter = counter;
  }

  async execute({ uid, claims }) {
    const account = await this.accessRepository.findAccountByClaims({
      uid,
      adminOf: claims?.adminOf,
      groupId: claims?.groupId,
    });
    if (!account?.hasEstablishment) {
      throw new AppError('Conta sem estabelecimento ativo.', {
        statusCode: 403,
        code: 'data_establishment_required',
      });
    }

    const storeRef = this.firestore.collection('estabelecimentos').doc(account.establishmentId);
    return this.counter.recalcularCategorias({
      storeRef,
      geradoEm: FieldValue.serverTimestamp(),
    });
  }
}
