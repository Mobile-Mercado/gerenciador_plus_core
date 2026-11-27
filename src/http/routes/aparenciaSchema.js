import { z } from 'zod';
import {
  ARQUIVOS_DA_APARENCIA, COR, ID_SEGURO, TEXTO_MAX, TIPOS_DE_FUNDO, TITULO_MAX,
} from '../../domain/loja/aparencias.js';
import { BLOCOS_DA_JORNADA, TEXTO_DA_JORNADA_MAX, numeroValido } from '../../domain/loja/primeiroAcesso.js';

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

function campoSchema(campo) {
  switch (campo.tipo) {
    case 'numero':
      return z.number().refine((valor) => numeroValido(campo, valor), {
        message: `Use um número de ${campo.minimo} a ${campo.maximo}, de ${campo.passo} em ${campo.passo}.`,
      }).nullable().optional();
    case 'opcao':
      return z.enum(campo.opcoes).nullable().optional();
    case 'bool':
      return z.boolean().nullable().optional();
    case 'texto':
      return z.string().max(TEXTO_DA_JORNADA_MAX).nullable().optional();
    case 'cor':
      return cor.nullable().optional();
    default:
      return z.null().optional(); // URL: so entra pelo envio do arquivo
  }
}
const blocoDaJornadaSchema = (campos) => z.object(Object.fromEntries(Object.entries(campos).map(([chave, campo]) => [chave, campoSchema(campo)]))).strict();

// Admin: Ofertas, Abertura, Primeira tela e a jornada Primeiro acesso.
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
  // Abertura, Primeira tela e os blocos da jornada Primeiro acesso (cola B56-24, A2), pela tabela
  // de domain/loja/primeiroAcesso.js. null apaga a chave (volta ao padrao).
  ...Object.fromEntries(Object.entries(BLOCOS_DA_JORNADA).map(([nome, campos]) => [nome, blocoDaJornadaSchema(campos).optional()])),
}).strict();

// Lojista: so o fundo de Ofertas.
export const fundoDeOfertasSchema = fundoSchema;

// Cola B56-24: a imagem da Primeira tela vai ate 300 KB (base64 ~410 mil caracteres); o limite
// de cada alvo e conferido no caso de uso.
export const arquivoDaAparenciaSchema = z.object({
  conteudoBase64: z.string().min(1).max(420000),
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

// Cola B56-21: incluirAjusteProprio e a caixa "Mudar tambem as M lojas com ajuste proprio" (padrao
// desmarcada). No DELETE (voltar ao original) vai na consulta.
export const padraoSchema = z.object({ ajustes: ajustesSchema, incluirAjusteProprio: z.boolean().optional() }).strict();
export const voltarAoOriginalSchema = z.object({ incluirAjusteProprio: z.enum(['true', 'false']).optional() });
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

// ===== Cola B56-25 (item 7): cores padrao das lojas novas =====
export const coresPadraoSchema = z.object({ loja: cor, sistema: cor }).strict();

// ===== Cola B56-24 (A2): animacao padrao da Abertura de todas as lojas =====
export const animacaoPadraoSchema = z.object({
  conteudoBase64: z.string().min(1).max(170000),
  tipoArquivo: z.string().min(1).max(40),
  nome: z.string().max(120).optional(),
  incluirAnimacaoPropria: z.boolean().optional(),
}).strict();

// Criador de icones com IA (Thay, 27/11): uma categoria por chamada.
export const iconeComIaSchema = z.object({
  categoriaId: z.string().trim().min(1).max(120).regex(/^[^/]+$/),
  categoria: z.string().trim().min(1).max(80),
  estilo: z.enum(['3d', 'linha', 'plano', 'aquarela']).default('3d'),
  detalhes: z.string().trim().max(300).default(''),
  qualidade: z.enum(['low', 'medium', 'high']).default('medium'),
  transparente: z.boolean().default(true),
  referenciaConjuntoId: z.string().trim().min(1).max(120).regex(/^[^/]+$/).nullable().default(null),
  conjuntoId: z.string().trim().min(1).max(120).regex(/^[^/]+$/).nullable().default(null),
});
