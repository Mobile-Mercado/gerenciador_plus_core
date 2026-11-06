import express from 'express';
import { AppError } from '../../domain/errors/AppError.js';
import { LIMITE_ENTRADA_BYTES, MENSAGEM_ACIMA_DO_LIMITE } from '../../application/cadastro/ImagensDaLoja.js';

// Foto da loja como sai do celular: o corpo e o arquivo, ate 20 MB. Acima disso a resposta
// diz o limite e como resolver, nunca o erro tecnico do leitor.
const leitor = express.raw({ type: () => true, limit: LIMITE_ENTRADA_BYTES });

export function corpoDeImagem(request, response, next) {
  leitor(request, response, (error) => {
    if (error?.type === 'entity.too.large') {
      next(new AppError(MENSAGEM_ACIMA_DO_LIMITE, { statusCode: 413, code: 'imagem_acima_do_limite' }));
      return;
    }
    if (error) {
      next(new AppError('Não deu para receber a foto. Tente de novo.', { statusCode: 400, code: 'imagem_nao_recebida', cause: error }));
      return;
    }
    next();
  });
}
