# Créditos

O workflow de exemplo `implement-issue` segue, em código, os fluxos de skills de outras pessoas. As instruções das
etapas ficam em [`workflows/implement-issue/prompts.ts`](workflows/implement-issue/prompts.ts) e são paráfrases em
pt-BR, não cópias.

| Origem | Autor | Licença | O que o workflow usa |
|---|---|---|---|
| [`tdd`](https://github.com/mattpocock/skills) (mattpocock/skills 1.3.1) | Matt Pocock | MIT | Seams combinadas antes dos testes; fatias verticais; red antes de green; teste pela interface pública; anti-padrões (acoplado à implementação, tautológico, fatiamento horizontal); refactor fora do laço |
| [`codebase-design`](https://github.com/mattpocock/skills) (idem) | Matt Pocock | MIT | Vocabulário de módulo profundo, interface, seam e adapter; "Design it twice" com três restrições para o tier HIGH |
| [`code-review`](https://github.com/mattpocock/skills) (idem) | Matt Pocock | MIT | Eixos Standards e Spec em paralelo, sem misturar nem reordenar; baseline de code smells de Fowler como julgamento |
| [`pr`](https://github.com/mattpocock/skills) (idem) | Matt Pocock | MIT | Template do corpo do PR: Summary, Evidence (antes e depois), Merge Danger (porta e raio de impacto) |
| [`show-me`](https://github.com/humanlayer/skills) (humanlayer/skills), via `pr` | Dex Horthy | MIT | Menu de visuais do Summary (pseudocódigo, árvore de chamadas, árvore de arquivos, Mermaid, diff) |

A baseline de smells vem de Martin Fowler, *Refactoring* (cap. 3), citada pela skill `code-review`. O eixo de
Segurança do review e o controle do laço TDD pelo código (snapshots, testes rodados entre as etapas, progresso por
fatia) são deste kit.
