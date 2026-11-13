# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`docs/vision/03-conceitos.md`**: the glossary. It is chapter 1.3 of the pt-BR book: each entry gives the pt-BR term,
  its English name in parentheses when it differs, the definition, and an _Evite_ line with the synonyms not to use.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. They are in English.

This is a single-context repo: there is no `GLOSSARY.md` and no `GLOSSARY-MAP.md`, and none is to be created. The
`/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) adds a resolved term to
`docs/vision/03-conceitos.md`, in pt-BR and in that chapter's entry format, and a resolved decision to `docs/adr/`
(the ADR rules are in `docs/contributing/02-convencoes-do-livro.md`).

## File structure

```
/
├── docs/
│   ├── vision/03-conceitos.md         ← the glossary
│   └── adr/                           ← the decisions
│       ├── 0001-layered-config-with-hard-caps.md
│       └── ...
└── packages/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/vision/03-conceitos.md`. In English text, use the English term the entry gives. Don't drift to synonyms the entry's _Evite_ line lists.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0003 (detached jobs), but worth reopening because…_
