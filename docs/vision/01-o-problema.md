# 1.1 · O problema

Um agente de código conduz bem uma tarefa pequena. O problema aparece quando o processo inteiro, com várias etapas,
fica nas mãos dele. Este capítulo diz o que dá errado nesse caso, o que falta no Cursor para tirar a condução do
modelo e o que, mesmo com um runtime pronto, impede um time de adotá-lo. A resposta do kit está em
[1.2](02-a-ideia-e-as-referencias.md).

## Quando o modelo conduz o processo

Num chat, o agente decide a cada turno o que fazer a seguir: ler, planejar, editar, rodar os testes, revisar, abrir o
PR. Uma skill, um `AGENTS.md` ou um prompt longo *pedem* essa ordem, mas nada a garante. Disso saem quatro falhas:

- **Etapa pulada em silêncio.** O modelo infere quando cada passo roda. Se ele julga que o review não vale a pena,
  o review não acontece, e nada avisa.
- **Modelo grande para tudo.** O contexto de uma conversa longa carrega o plano, o diff e os logs de teste de uma vez, e
  costuma exigir um modelo grande. A maior parte do trabalho (classificar, rodar uma fatia de TDD, redigir o texto
  do PR) caberia num modelo menor, se cada etapa recebesse uma tarefa pequena e fechada.
- **Custo sem dono.** O gasto é a soma de turnos que ninguém planejou. Não existe um ponto do processo em que o
  código possa dizer "pare, o teto acabou".
- **Nada repetível.** A orquestração vive na conversa. Para repetir o processo é preciso pedir de novo, e para
  retomá-lo depois de uma queda é preciso reexplicar onde ele parou.

O pedido que originou o kit resume o alvo: garantir a execução completa, sem depender de o modelo inferir quando cada
passo roda, e permitir modelos menores ([8.1 §1.2](../research/relatorio-pesquisa.md)).

## O Cursor não traz um runtime para isso

O Claude Code resolveu a condução com a ferramenta Workflow: um script que o runtime executa, com resultados
intermediários em variáveis, em vez de um prompt que o modelo segue ([8.1 §1](../research/relatorio-pesquisa.md)).
O Cursor não tem equivalente nativo: nem a ferramenta, nem uma DSL de etapas, nem retomada por journal, nem saída
estruturada validada por schema (comparação linha a linha em
[8.1 §3](../research/relatorio-pesquisa.md)).

O que o Cursor tem são as peças para construí-lo: agentes criados por código, com o modelo escolhido a cada chamada,
streaming, cancelamento, custom tools no processo e consulta de uso. O `dag-task-runner` do cookbook oficial prova que
o padrão funciona, mas o plano (o DAG) continua escrito pelo modelo, sem schema, journal nem teto de custo
([8.1 §2.3](../research/relatorio-pesquisa.md)).

## O que um runtime pronto ainda deixa de fora

A versão 0.2.0 do kit já era um runtime que roda workflows no Cursor SDK. Usá-lo no dia a dia de um time, e não só na
máquina de quem o escreveu, esbarrava em cinco problemas. Os dois primeiros foram vistos ao vivo na sessão que planejou
a etapa seguinte do kit, a [spec de fundação (#2)](https://github.com/rodrigorjsf/cursor-workflows-starter/issues/2). A
coluna da direita diz o que essa spec decidiu; parte já está no código, parte ainda está sendo construída.

| Problema na 0.2.0 | O que acontecia | A resposta da spec #2 |
|---|---|---|
| **A instalação falha em silêncio** | O MCP server aponta para um `node_modules/.bin/tsx` relativo. Sem dependências instaladas, o servidor não sobe (`ENOENT`) e a única pista está no log do MCP. Mesmo depois de instalar, o `node` do PATH era o 22.11, abaixo do 22.13 que o SDK exige | Um comando de diagnóstico, `wf doctor`, que confere o Node que o IDE usa e cada pré-requisito e diz o que corrigir; a instalação em um passo, pinada a uma tag. Já no código: o `wf doctor`. Em construção: a instalação |
| **A configuração é dispersa e presa ao código** | Modelos, tetos de tokens e centavos, timeouts e tentativas ficam no código de cada workflow ou em variáveis `WF_*` avulsas. Não há arquivo de repositório nem de usuário, e nada protege os tetos de um PR que edite a configuração do repositório | Configuração em camadas com tetos globais ([ADR-0001](../adr/0001-layered-config-with-hard-caps.md)). Em construção |
| **Os runs são frágeis e opacos** | Um job roda dentro do processo do MCP server: reiniciar o Cursor o mata e um teste longo trava o servidor. Não há como cancelar. O teto zera a cada resume. Os eventos não traziam horário, `runId` nem `stepId`. O estado do job era reescrito sem atomicidade e podia ser lido pela metade. Uma última linha do journal cortada impedia o resume | O log de eventos como fonte da verdade ([ADR-0002](../adr/0002-event-log-source-of-truth.md)) e jobs destacados ([ADR-0003](../adr/0003-detached-jobs.md)). Já no código: os eventos com horário e ids ([6.1](../reference/events.md)), a escrita atômica, a última linha cortada tolerada e o lock por run. Em construção: o job destacado, o cancelamento e o teto que acumula entre resumes |
| **O repositório mistura produto e desenvolvimento** | O `AGENTS.md` da raiz juntava a orientação para desenvolver este repositório com as regras que todo repositório que usa o kit deve seguir. As skills distribuídas moravam na mesma pasta das skills de desenvolvimento. A documentação eram nove capítulos soltos, sem ordem de leitura | Pacote de runtime próprio e `CLAUDE.md` canônico ([ADR-0004](../adr/0004-workspaces-and-claude-md-symlink.md)); o livro que você está lendo. Já no código |
| **Não há como provar que funciona no Cursor IDE** | Sem um caminho repetível de validação, "funciona no IDE" é uma impressão, não uma evidência | Seis cenários de validação, rodados por um assistente guiado, e um workflow `smoke` barato. Em construção |

O que a ideia do kit propõe para o conjunto está em [1.2](02-a-ideia-e-as-referencias.md), e o vocabulário que o resto do
livro usa, em [1.3](03-conceitos.md).

---

[Índice](../README.md) · [Próximo: 1.2 · A ideia e as referências →](02-a-ideia-e-as-referencias.md)
