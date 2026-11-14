import { z } from 'zod';
import {
  ARQUIVOS_DA_APARENCIA, COR, ID_SEGURO, TEXTO_MAX, TIPOS_DE_ABERTURA, TIPOS_DE_FUNDO, TITULO_MAX,
} from '../../domain/loja/aparencias.js';

// Aparencias da loja (cola B56-04). Os limites vem de domain/loja/aparencias.js. As URLs de
// arquivo so entram pelo envio do arquivo; aqui so podem ser apagadas (null).
const cor = z.string().regex(COR, 'Use a cor no formato #RRGGBB.').transform((valor) => valor.toUpperCase());
const texto = (maximo) => z.string().trim().min(1).max(maximo);

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

const fundoSchema = z.object({
  tipo: z.enum(TIPOS_DE_FUNDO).optional(),
  cor: cor.nullable().optional(),
  imagemUrl: z.null().optional(),
  animacaoUrl: z.null().optional(),
}).strict();

// Admin: Ofertas, Abertura e Primeira tela.
export const aparenciaDaLojaSchema = z.object({
  ofertas: z.object({
    fundo: fundoSchema.optional(),
    cabecalho: z.object({
      ligado: z.boolean().optional(),
      titulo: texto(TITULO_MAX).nullable().optional(),
      texto: texto(TEXTO_MAX).nullable().optional(),
      imagemUrl: z.null().optional(),
    }).strict().optional(),
    lojistaPodeTrocarFundo: z.boolean().optional(),
  }).strict().optional(),
  abertura: z.object({
    tipo: z.enum(TIPOS_DE_ABERTURA).optional(),
    cor: cor.nullable().optional(),
    animacaoUrl: z.null().optional(),
  }).strict().optional(),
  primeiraTela: z.object({
    cor: cor.nullable().optional(),
    logoUrl: z.null().optional(),
  }).strict().optional(),
}).strict();

// Lojista: so o fundo de Ofertas.
export const fundoDeOfertasSchema = fundoSchema;

export const arquivoDaAparenciaSchema = z.object({
  conteudoBase64: z.string().min(1).max(170000),
  tipoArquivo: z.string().min(1).max(40),
}).strict();

export const alvoDoArquivoSchema = z.enum(Object.keys(ARQUIVOS_DA_APARENCIA));

// ===== Cola B56-08: modelos, padroes e banners =====
// As faixas de cada ajuste sao conferidas no caso de uso (domain/loja/variacoesDaHome.js).
const ajustesSchema = z.record(z.union([z.number(), z.string().max(20), z.boolean(), z.null()]));
const blocoSchema = z.enum(['topo', 'meio', 'fim']);

export const novoModeloSchema = z.object({
  nome: z.string().max(200),
  bloco: blocoSchema,
  base: z.number().int().min(1).max(6),
  ajustes: ajustesSchema.optional(),
}).strict();

export const alterarModeloSchema = z.object({
  nome: z.string().max(200).optional(),
  ajustes: ajustesSchema.optional(),
}).strict();

export const padraoSchema = z.object({ ajustes: ajustesSchema }).strict();
export const variacaoParamsSchema = z.object({ bloco: blocoSchema, numero: z.coerce.number().int().min(1).max(6) });
export const afetadasSchema = z.object({
  bloco: blocoSchema.optional(),
  numero: z.coerce.number().int().min(1).max(6).optional(),
  modelo: z.string().regex(ID_SEGURO).optional(),
}).refine((consulta) => consulta.modelo || (consulta.bloco && consulta.numero), { message: 'Informe o modelo, ou o bloco e o número.' });
export const modelosConsultaSchema = z.object({ bloco: blocoSchema.optional() });

export const novoBannerSchema = z.object({
  tipo: z.enum(['principal', 'vertical', 'posVertical', 'popup']),
  inicio: z.string().min(1).max(40),
  fim: z.string().min(1).max(40),
});
export const alterarBannerSchema = z.object({
  inicio: z.string().min(1).max(40).optional(),
  fim: z.string().min(1).max(40).optional(),
  ligado: z.boolean().optional(),
  contador: z.boolean().optional(),
}).strict();
export const bannerParamsSchema = z.object({ lojaId: z.string().min(1).max(120), bannerId: z.string().min(1).max(120).regex(/^[^/]+$/) });
