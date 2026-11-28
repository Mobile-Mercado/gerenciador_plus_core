import { contarAlterados, diaEmSaoPaulo, inicioDoDiaEmSaoPaulo } from '../../domain/integrador/alteradosHoje.js';

// Cola 100, item 6: "Alterados hoje" da faixa da aba Integrador, contado no Core (o integrador nao
// muda). A tela pergunta a cada minuto; o resultado de cada loja fica guardado por 60 s nesta
// instancia, para nao reler os itens do dia (milhares em dia de carga grande) a cada pergunta.
export const GUARDA_MS = 60_000;

export class AlteradosHoje {
  constructor({ repositorio, clock = () => new Date() }) {
    this.repositorio = repositorio;
    this.clock = clock;
    this.guardados = new Map();
  }

  async contar({ lojaId }) {
    const agora = this.clock();
    const dia = diaEmSaoPaulo(agora);
    const chave = `${lojaId}/${dia}`;
    const guardado = this.guardados.get(chave);
    if (guardado && guardado.ate > agora.getTime()) return guardado.resposta;
    const desde = inicioDoDiaEmSaoPaulo(agora);
    const itens = await this.repositorio.itensDesde({ lojaId, desde });
    const resposta = { dia, alterados: contarAlterados(itens) };
    if (this.guardados.size > 2000) this.guardados.clear();
    this.guardados.set(chave, { resposta, ate: agora.getTime() + GUARDA_MS });
    return resposta;
  }
}
