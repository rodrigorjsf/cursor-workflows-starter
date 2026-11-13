---
paths:
  - "**/*.md"
---

# Diagrams in Markdown

When you add or change a Mermaid diagram in a Markdown file, follow the diagram conventions in
[docs/contributing/03-diagramas.md](../../docs/contributing/03-diagramas.md).

The CI job `mermaid` renders every block, so a syntax error fails the PR. It cannot run locally;
`npm run docs:mermaid -- --list` lists the blocks it will check.
