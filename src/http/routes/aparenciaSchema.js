import { z } from 'zod';
import { ID_SEGURO } from '../../domain/loja/aparencias.js';

// Conjuntos de icones (cola B56-04), na branch icones-conjuntos (cola B56-16).
export const conjuntoNomeSchema = z.object({ nome: z.string().max(200) }).strict();

// Icone em base64, como a troca de icone da lista padrao. PNG acima de 20 KB ainda chega para
// virar WEBP; o limite final e conferido no caso de uso.
export const iconeDoConjuntoSchema = z.object({
  conteudoBase64: z.string().min(1).max(600000),
  tipoArquivo: z.string().min(1).max(40),
}).strict();

export const conjuntoDaLojaSchema = z.object({
  conjuntoId: z.string().regex(ID_SEGURO).nullable(),
}).strict();
