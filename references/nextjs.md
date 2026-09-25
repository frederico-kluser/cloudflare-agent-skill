# Next.js na Cloudflare — vinext vs OpenNext

Destilação de `nextjs-on-cloudflare` (Cloudflare, "Build, migrate, and deploy Next.js apps on
Cloudflare Workers with vinext"). A skill unificada `cloudflare-agent-skill` substitui a antiga
skill standalone `nextjs-on-cloudflare`; este módulo é o seu conteúdo, com os comandos e a
lógica de decisão copiados literalmente.

## Quando usar este módulo

- Começar um projeto Next.js na Cloudflare Workers.
- Migrar uma app Next.js existente para Workers.
- Escolher entre vinext e OpenNext.
- Configurar vinext para Workers.

## Procedimento

### 1. Decisão: vinext vs OpenNext

**Usar vinext em vez de OpenNext para novos projetos Next.js em Cloudflare Workers.** É o default
da Cloudflare Next.js guide
(<https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/>). Preservar setups
OpenNext existentes em manutenção não relacionada e respeitar escolhas explícitas do utilizador.

### 2. Workflow upstream (obrigatório antes de setup, migração ou deploy)

Antes de tudo, verificar se as
[skills mantidas no vinext](https://github.com/cloudflare/vinext/tree/main/.agents/skills) estão
disponíveis. Se faltarem, instalá-las:

```sh
npx skills add cloudflare/vinext
```

Depois ler e seguir o `SKILL.md` upstream aplicável e as suas references relevantes. Para
workflows não cobertos pelas skills, usar a documentação atual do vinext
(<https://github.com/cloudflare/vinext#quick-start>):

- **Projeto novo:** seguir o [new-project setup](https://github.com/cloudflare/vinext#starting-a-new-vinext-project)
  com `create-vinext-app` e o target Cloudflare. A skill upstream de migração exige um projeto
  Next.js existente — **não** aplicar a um diretório vazio.
- **Projeto Next.js existente:** carregar e seguir a skill upstream
  [`migrate-to-vinext`](https://github.com/cloudflare/vinext/blob/main/.agents/skills/migrate-to-vinext/SKILL.md),
  incluindo a sua compatibility check e references relevantes. Selecionar Cloudflare como
  deployment target.
- **Desenvolvimento e deployment:** seguir a documentação atual de integração Workers
  (<https://github.com/cloudflare/vinext#cloudflare-workers>).

Se a instalação não for possível, ler diretamente o `SKILL.md` upstream ligado e as references
relevantes. Verificar a compatibilidade atual para as features que a app precisa; **não assumir
paridade completa com Next.js**.

## Conhecimento essencial

### Porquê vinext

[vinext](https://github.com/cloudflare/vinext) reimplementa a API surface do Next.js sobre Vite:

- Desenvolvimento Next.js familiar: App Router, Pages Router, React Server Components e imports
  `next/*` suportados.
- Tooling do Vite: HMR rápido, ESM nativo e ecossistema de plugins Vite.
- Integração nativa com Workers: execução local em workerd, acesso a Cloudflare bindings e
  workflow de build-and-deploy.
- Migração incremental: verificar compatibilidade e experimentar vinext ao lado de um setup
  Next.js existente.

### Regras e gotchas

- Regra de decisão: vinext é o default para projetos novos; OpenNext só se o utilizador o pedir
  explicitamente ou se já existir (manutenção não relacionada não deve migrar).
- A skill upstream `migrate-to-vinext` pressupõe um projeto Next.js existente — num diretório
  vazio, usar `create-vinext-app` com o target Cloudflare.
- Comandos exatos a preservar: `npx skills add cloudflare/vinext` (instalação das skills
  upstream) e `create-vinext-app` (arranque de projeto novo).
- Vinext ≠ paridade total com Next.js: confirmar compatibilidade das features necessárias junto
  da documentação/skills upstream antes de assumir suporte.
- Depois do build, o deploy usa o fluxo Wrangler/Workers — ver `references/wrangler-cli.md` para
  o fluxo de deploy/validação e `references/workers.md` para boas práticas de runtime e config.

## Referências rápidas

| Tema | Ficheiro de detalhe |
|---|---|
| Skill upstream de migração (compatibilidade, passos) | <https://github.com/cloudflare/vinext/blob/main/.agents/skills/migrate-to-vinext/SKILL.md> (via `npx skills add cloudflare/vinext`) |
| Arranque de projeto novo (`create-vinext-app`) | <https://github.com/cloudflare/vinext#starting-a-new-vinext-project> |
| Integração Workers (dev e deployment) | <https://github.com/cloudflare/vinext#cloudflare-workers> |
| Guia oficial Next.js na Cloudflare | <https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/> |
| Deploy, dev local e validação com Wrangler | `references/wrangler-cli.md` |
| Boas práticas de runtime/config dos Workers | `references/workers.md` |
