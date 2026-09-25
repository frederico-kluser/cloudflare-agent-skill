# MCPs oficiais da Cloudflare (referência nível 3)

Fonte oficial: <https://developers.cloudflare.com/agent-setup/prompt.md> ·
repositórios: <https://github.com/cloudflare/skills> e
<https://github.com/cloudflare/mcp-server-cloudflare>.

## Servidores (endpoints remotos, OAuth na primeira utilização)

| Nome | URL | O que cobre |
|---|---|---|
| `cloudflare` | `https://mcp.cloudflare.com/mcp` | gestão geral da conta (Code Mode) |
| `cloudflare-docs` | `https://docs.mcp.cloudflare.com/mcp` | documentação (**público, sem auth**) |
| `cloudflare-bindings` | `https://bindings.mcp.cloudflare.com/mcp` | bindings de Workers |
| `cloudflare-builds` | `https://builds.mcp.cloudflare.com/mcp` | build logs / CI |
| `cloudflare-observability` | `https://observability.mcp.cloudflare.com/mcp` | observabilidade/logs |

## Registo por agente

**Claude Code** (plugin oficial — recomendado):
```bash
claude plugin marketplace add cloudflare/skills
claude plugin install cloudflare@cloudflare
# depois: /reload-plugins dentro do Claude
```

**Codex**:
```bash
codex mcp add cloudflare --url https://mcp.cloudflare.com/mcp
codex mcp add cloudflare-docs --url https://docs.mcp.cloudflare.com/mcp
codex mcp add cloudflare-bindings --url https://bindings.mcp.cloudflare.com/mcp
codex mcp add cloudflare-builds --url https://builds.mcp.cloudflare.com/mcp
codex mcp add cloudflare-observability --url https://observability.mcp.cloudflare.com/mcp
codex mcp login cloudflare
```

**OpenCode** (`~/.config/opencode/opencode.jsonc`, bloco `"mcp"`):
```jsonc
"cloudflare": { "type": "remote", "url": "https://mcp.cloudflare.com/mcp", "enabled": true, "oauth": {} },
"cloudflare-docs": { "type": "remote", "url": "https://docs.mcp.cloudflare.com/mcp", "enabled": true },
"cloudflare-bindings": { "type": "remote", "url": "https://bindings.mcp.cloudflare.com/mcp", "enabled": true, "oauth": {} },
"cloudflare-builds": { "type": "remote", "url": "https://builds.mcp.cloudflare.com/mcp", "enabled": true, "oauth": {} },
"cloudflare-observability": { "type": "remote", "url": "https://observability.mcp.cloudflare.com/mcp", "enabled": true, "oauth": {} }
```
Depois: `opencode mcp auth cloudflare`.

**Cursor / Copilot / outros** (`.cursor/mcp.json`, `.vscode/mcp.json` ou o
`mcpServers` do agente):
```json
{
  "mcpServers": {
    "cloudflare": { "url": "https://mcp.cloudflare.com/mcp" },
    "cloudflare-docs": { "url": "https://docs.mcp.cloudflare.com/mcp" },
    "cloudflare-bindings": { "url": "https://bindings.mcp.cloudflare.com/mcp" },
    "cloudflare-builds": { "url": "https://builds.mcp.cloudflare.com/mcp" },
    "cloudflare-observability": { "url": "https://observability.mcp.cloudflare.com/mcp" }
  }
}
```

## Skills oficiais Cloudflare (já fundidas nesta skill)

`npx -y skills add cloudflare/skills --skill '*' --yes --global` instala em
`~/.agents/skills/`: `cloudflare`, `wrangler`, `workers-best-practices`,
`durable-objects`, `agents-sdk`, `cloudflare-one`, `cloudflare-one-migrations`,
`cloudflare-email-service`, `nextjs-on-cloudflare`, `sandbox-stable`,
`sandbox-next`, `sandbox-migrate-to-next`, `turnstile-spin`, `web-perf`.
Estas são as skills de PRODUTO (como construir); a `cloudflare-agent-skill`
(cobre a ORQUESTRAÇÃO por terminal). Complementam-se.

## API MCP (Code Mode) avançada

<https://github.com/cloudflare/mcp> — servidor MCP que expõe a API v4 completa
com execução de código confinada. Para automação pesada da API, preferir o
`scripts/cf-api.sh` desta skill (determinístico e offline-testável).
