# cloudflare-agent-skill

Agent skill (formato `SKILL.md` — Claude Code, opencode, Codex, pi, …) que controla **todo o
Cloudflare** por terminal e código, e publica qualquer URL local no **seu domínio** com um
comando — preservando o `?token=` — e derruba com outro.

```bash
python3 scripts/expose-port/domain.py up 'http://127.0.0.1:3080/?token=XYZ'
# OK: publicado em 0.7 s
# URL=https://3080.example.com/?token=XYZ

python3 scripts/expose-port/domain.py down 3080     # 404 na hora (~0,3 s)
```

## O que cobre

| Área | Como |
|---|---|
| Publicar URL/porta local no domínio próprio | `scripts/expose-port/domain.py` — named tunnel + curinga `*.zona`, ~0,7 s por host novo |
| Link temporário sem conta/domínio | quick tunnel `trycloudflare.com` com senha `?key=` + QR (`scripts/expose-port/expose-port.sh`) |
| Workers, Pages, KV, D1, R2, Queues, Durable Objects, Agents SDK | `wrangler` + módulos em `references/` |
| DNS, zonas, nameservers, SSL/TLS, API v4 | `scripts/cf-dns.sh`, `scripts/cf-api.sh` (paginação, erros `Erro/Solução`) |
| Zero Trust / Cloudflare One, Email Routing/Sending, Turnstile, Sandbox, Next.js (vinext) | `references/*.md` + snapshot das skills oficiais em `references/upstream/` |

O `SKILL.md` é um roteador enxuto: o agente carrega só o módulo que a tarefa precisa.

## Instalar

```bash
git clone https://github.com/frederico-kluser/cloudflare-agent-skill.git
cd cloudflare-agent-skill
bash scripts/link-skill-global.sh          # regista a skill (symlink) em todos os agentes da máquina
bash scripts/expose-port/install.sh        # opcional: atalho `expose-port-cloudflare-agent-skill`
python3 scripts/expose-port/domain.py setup   # opcional: prepara já (senão o 1º `up` prepara)
```

## Preparação automática

Numa máquina nova, o primeiro `up` (ou `setup`) faz tudo sozinho, sem sudo e sem perguntas:

- instala o **cloudflared** (binário oficial do GitHub, SHA256 verificado) em `~/.local/bin`;
- instala **Node LTS** (nodejs.org, SHA256) numa pasta privada, se não houver Node ≥ 18.13;
- sem credencial, corre `cloudflared tunnel login` e abre o browser — **o único passo humano é
  escolher o domínio e clicar _Authorize_** (a URL também serve noutro aparelho);
- grava o domínio padrão, prova as permissões (DNS e túnel, com testes reversíveis) e liga o
  linger do systemd para shares persistentes.

O `cert.pem` desse login chega para túnel + DNS da zona autorizada; um token de API
(`CLOUDFLARE_API_TOKEN` com Zone·DNS·Edit + Account·Cloudflare Tunnel·Edit) é opcional.
`domain.py setup --check` só relata, sem mudar nada.

## Publicar no domínio próprio

```bash
python3 scripts/expose-port/domain.py up 'localhost:5173/app' --name app   # https://app.example.com/app
python3 scripts/expose-port/domain.py up '<url>' --name @ --persist        # apex, sobrevive a reboot
python3 scripts/expose-port/domain.py up '<url>' --gate                    # senha ?key= p/ apps sem login
python3 scripts/expose-port/domain.py list
python3 scripts/expose-port/domain.py down all
python3 scripts/expose-port/domain.py purge example.com   # remove túnel, curinga e registos da skill
```

Como funciona: um túnel nomeado por zona e máquina, um CNAME curinga `*.zona` → túnel (criado
uma vez) e um router local (`zone-runner.mjs`, Node sem dependências) que encaminha por `Host`.
Um host novo é só uma rota — não há DNS a propagar. O router reescreve `Host`/`Origin` para o
upstream (passa em fences como o `allowedHosts` do Vite), corrige redirects absolutos, deixa
WebSocket e SSE intactos, e responde 404 a hosts sem rota. Cada `up` só diz `OK` depois de
provar a URL pela edge da Cloudflare, sem depender de DNS recursivo.

Medido numa zona Free: host novo ~0,7 s · rota existente ~0,2 s · `down` ~0,3 s · primeira vez
numa zona ~10 s. Detalhes, limites e troubleshooting em
[`references/expose-port.md`](references/expose-port.md).

## Requisitos

- Linux ou macOS (Windows via WSL), `python3` ≥ 3.9.
- Um domínio ativo numa conta Cloudflare (plano grátis serve) para o modo domínio.
- `--persist` usa `systemd --user` (Linux); sem ele os shares funcionam, mas caem no reboot.

## Limites a conhecer

- Só HTTP/HTTPS (web, APIs, WebSocket, SSE). SSH, bases de dados e TCP/UDP cru não passam.
- É um túnel para a sua máquina: desligada ou a dormir, a URL cai (para ficar sempre no ar,
  use Pages/Workers — a skill também faz).
- Plano grátis da Cloudflare: upload máx. 100 MB por pedido, resposta tem de começar em 100 s
  (senão 524), e os termos não permitem servir vídeo/ficheiros grandes em volume pelo proxy.
- Subdomínios de um nível (`app.example.com`): o certificado grátis não cobre `a.b.example.com`.

## Segurança

- Nenhum segredo vive no repositório: token em `~/.config/cloudflare-agent-skill/credentials.env`
  (0600) ou no ambiente; o token do `cert.pem` só é lido em memória.
- App sem autenticação num host previsível fica pública — use `--gate` ou Cloudflare Access.
- Instalações verificadas por SHA256; nada corre com sudo (só `sudo -n` opcional para o linger).

## Licença

MIT — ver [LICENSE](LICENSE).
