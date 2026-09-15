# Regras desta pasta

## Escopo
Só o `gerenciador_plus_core`. Não tocar em outro repositório, no `web_gerenciador_plus`, no app do consumidor, no app do lojista ou no agente de vendas.

Dentro deste repositório, mexer apenas no que o pedido da mensagem descreve. Este backend está em produção e serve lojas reais.

## Execução
Fazer somente o que está escrito no pedido da mensagem. Nada além.

Sem melhoria não pedida. Sem refatoração. Sem renomear arquivo ou variável. Sem atualizar dependência. Sem formatar código que não faz parte da mudança. Sem corrigir defeito que não foi mencionado no pedido.

Se notar algo fora do pedido, escreva no fim da resposta em uma linha e pare. Não corrija.

## Antes de editar
Apresentar plano numerado com os arquivos que vão mudar e o que muda em cada um. Esperar minha confirmação. Sem confirmação, não edita.

Renomear ou extrair função entra no plano como item a confirmar, mesmo quando for consequência natural da mudança pedida.

## Nada que rode sozinho
Não executar script de migração, backfill, deploy de function ou qualquer comando que escreva no Firestore de produção. Escrever o script é seu; rodar é meu.

## Git
Não fazer commit, branch, push, PR nem merge. Só eu comito.

## Decisões que não são suas
Estrutura (onde um arquivo mora), acesso (login, permissão, chave), dinheiro (custo, plano, cobrança) e qualquer mudança em regra do Firestore: dizer a opção e perguntar antes de executar. Não decidir sozinho.

## Dados de produção
Nunca imprimir nome, telefone, endereço, CPF, itens de pedido ou dados de pagamento de cliente em log, script ou resposta.

## Arquivos novos
Não criar arquivo, documentação, README, script ou teste sem eu pedir. Apagar os temporários no fim de cada rodada.

## Respostas
Curtas. A mudança e onde. Sem histórico do problema, sem resumo do que foi feito, sem relatório não solicitado.
