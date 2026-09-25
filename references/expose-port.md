# Expor porta local com senha (Cloudflare Tunnel)

Torna qualquer serviço local (`http://127.0.0.1:<port>` ou `http://localhost:<port>`) numa URL pública `https://*.trycloudflare.com` **protegida por senha**: a skill gera uma senha aleatória de 256 bits, acrescenta-a à URL (`?key=…`) e imprime o **link completo como QR code no terminal** — a pessoa digital e abre. Sem conta Cloudflare, sem domínio, sem DNS, sem alterar regras de firewall e **sem tocar no projeto servido** (todo o código de suporte vive ao lado, em `scripts/expose-port/`).

- Ninguém sem a senha acede (HTTP **e** WebSocket): pedidos sem a key e sem session cookie recebem **401**.
- A senha **vale até ser revogada** — reutilizável por omissão (um link preview, um segundo device ou uma reabertura nunca a queimam; `TOKEN_REUSE=0` restaura single-use). Ao abrir o link, o browser é redirecionado para a **URL limpa** (senha removida, `Referrer-Policy: no-referrer`) e recebe uma session cookie segura (HttpOnly, SameSite=Strict, Secure).
- **Nada expira sozinho**: sem TTL por omissão; as sessões duram até o proxy reiniciar (`TOKEN_TTL_MS`/`SESSION_TTL_MS` limitam opcionalmente). O link só deixa de funcionar quando é revogado (`new-link.sh`), o túnel é parado (`stop`/`stop-all`) ou os processos morrem. Uma senha nova pode ser gerada a qualquer momento com `new-link.sh` — a URL pública mantém-se.

## Quando usar

- Alguém precisa de um link público para um servidor local (dev UI, API, dashboard, preview build) e o acesso tem de ficar limitado a quem tem a senha.
- O serviço ouve apenas em `127.0.0.1`/`localhost` (os túneis funcionam na mesma — o cloudflared liga-se localmente).
- Não se pode modificar o projeto a expor (config, `allowedHosts`, etc.).

**Quando NÃO usar:**

- Exposição em produção → usar um **named tunnel** (conta Cloudflare + domínio) com **Cloudflare Access** (auth por identidade) em vez de uma senha partilhada.
- Não há `node` disponível — o gate proxy (zero deps, `node:http/https`) precisa dele.
- O destinatário tem de ser uma **pessoa identificável que se possa revogar**: qualquer um com o link acede até gerar link novo (`new-link.sh`) ou parar o túnel.

## Procedimento

**1. Pré-requisitos** (uma vez por máquina):

```sh
# cloudflared (Linux x86_64):
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared && chmod +x cloudflared && sudo mv cloudflared /usr/local/bin/
# node: qualquer LTS moderno (gate proxy, zero deps)
# qrencode (recomendado para o QR no terminal — com fallback gracioso):
sudo apt install qrencode
```

**2. Expor** — arranca o gate proxy + quick tunnel e imprime o link + QR:

```sh
bash scripts/expose-port/expose-port.sh http://localhost:8080
```

O alvo é parseado com inteligência: `8080`, `localhost:8080`, `http://localhost:8080`, `127.0.0.1:8080` ou `https://host:9443/path` funcionam todos. Um path no alvo passa inalterado — acede à app sob o mesmo path na URL pública. Upstreams `https://` são suportados (certs dev/self-signed aceites — `rejectUnauthorized: false`).

**3. QR/senha** — o terminal mostra o link completo com `?key=…` e o respetivo QR code: a pessoa digital com o telemóvel e abre. Sem a senha a URL nua é inútil (401).

**4. Como funciona** (duas camadas em cada request **e** em cada WebSocket upgrade):

```
Browser ── QR → https://*.trycloudflare.com/?key=…(senha)
           │ Cloudflare edge (TLS, HTTP/2, WebSocket)
           ▼
      cloudflared (quick tunnel, outbound-only, sem conta)
           │ http://127.0.0.1:3100
           ▼
      scripts/expose-port/proxy.mjs — em cada request E WS upgrade:
      1. AUTH GATE   sem key + sem session cookie → 401 (WS: socket destroyed)
                     key válida → session cookie, 302 → URL limpa
                     (key removida, no-referrer); key mantém-se válida
                     (reutilizável por omissão; TOKEN_REUSE=0 queima-a)
                     session cookie → autorizado (inclui WS upgrades)
      2. REWRITE     Host + Origin → <upstream> (loopback), para passarem as
                     host-validation fences (Vite CVE-2025-24010, fences /api)
           ▼
      o servidor local (intocado)
```

Propriedades de segurança-chave: comparação constant-time (`crypto.timingSafeEqual`), token de 256 bits (CSPRNG); cookie `HttpOnly, SameSite=Strict, Secure` com scope por host (state em memória — reiniciar o proxy revoga tudo, e é exatamente isso que `new-link.sh` faz); `Referrer-Policy: no-referrer` e `Cache-Control: no-store` em todas as respostas; upgrades WebSocket rejeitados com **401 antes de qualquer frame** (o handshake é um GET plain HTTP e os browsers enviam cookies — RFC 6455 — logo o mesmo gate cobre WS sem código extra).

**5. Partilhar** — validar antes de entregar o URL (comandos exatos em `## Comandos`; `401` = gate ativo e nunca consome a senha).

**6. Revogar / parar** — `new-link.sh` (mesma URL pública, sessões antigas revogadas), `stop.sh` (túnel + proxy) ou `stop-all.sh` (todos os quick tunnels e gate proxies da máquina; named tunnels de conta nunca são tocados).

## Comandos

Todos a partir da raiz da skill; os argumentos do alvo são os mesmos do ponto 2.

```sh
bash scripts/expose-port/expose-port.sh http://localhost:8080   # expor (ou: 8080 | localhost:8080 | 127.0.0.1:8080 | https://host:9443)
bash scripts/expose-port/new-link.sh    # outra senha, mesma URL pública (revoga as sessões anteriores)
bash scripts/expose-port/status.sh      # checks ao vivo (401 = gate ativo; nunca consome a senha)
bash scripts/expose-port/stop.sh        # pára túnel + proxy
bash scripts/expose-port/stop-all.sh    # pára TODO quick tunnel + gate proxy da máquina
bash scripts/expose-port/list.sh        # o que está a correr agora (read-only)
```

`list` mostra a instância tracked (processos, alvo, URL pública, estado do link) mais quick tunnels/proxies untracked (outras instalações, órfãos). Instalação global opcional (atalho de CLI em `~/.local/bin`, macOS/Linux — a skill vive unificada, não se regista à parte):

```sh
bash scripts/expose-port/install.sh             # idempotente; --dry-run | --uninstall | --help
expose-port-cloudflare-agent-skill 8080               # atalho global: expor
expose-port-cloudflare-agent-skill list               # o que está a correr (read-only)
expose-port-cloudflare-agent-skill stop               # pára o túnel + proxy tracked
expose-port-cloudflare-agent-skill stop-all           # pára TODOS os quick tunnels + gate proxies
```

Validação antes de entregar o URL (define `URL` como a URL pública impressa pelo comando de expor):

```sh
curl -s -o /dev/null -w "%{http_code}\n" "$URL/"                    # 401 (gate)
curl -s -o /dev/null -w "%{http_code}\n" "$URL/?key=invalid"        # 401
# usa uma key real (imprime um link e usa o seu token), depois:
curl -s -i "$URL/?key=<REAL_TOKEN>" | head -4                        # 302, Location limpo,
#  Set-Cookie HttpOnly/SameSite=Strict/Secure, Referrer-Policy: no-referrer
curl -s -o /dev/null -w "%{http_code}\n" "$URL/?key=<REAL_TOKEN>"   # 302 outra vez (reutilizável por omissão; 401 se TOKEN_REUSE=0)
curl -s -c jar -L -o /dev/null -w "%{http_code}\n" "$URL/?key=<REAL_TOKEN>"  # 200 com cookie
# WebSocket upgrade — USA OBRIGATORIAMENTE --http1.1 (sobre HTTP/2 a edge remove
# os headers Connection/Upgrade e obténs 426/502 em vez de 101):
curl -s --http1.1 -b jar -o /dev/null -w "%{http_code}\n" --max-time 8 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
  "$URL/<ws-path>"                                                  # 101 = pass
# sem o cookie: rejeitado (socket destroyed / 502 da edge)
```

Named tunnel para produção (conta + domínio obrigatórios):

```sh
cloudflared tunnel login
cloudflared tunnel create <name>                    # UUID + credentials file em ~/.cloudflared/
cloudflared tunnel route dns <name> app.yourdomain.com
# ~/.cloudflared/config.yml:
#   tunnel: <UUID>
#   credentials-file: /home/<user>/.cloudflared/<UUID>.json
#   ingress:
#     - hostname: app.yourdomain.com
#       service: http://127.0.0.1:3100      # o gate proxy — um custom domain também não é loopback
cloudflared tunnel --config ~/.cloudflared/config.yml run <name>
```

Com named tunnel, colocar **Cloudflare Access** à frente para auth por identidade — a forma correta de expor um agent/admin UI em produção. Docs: <https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/>

## Gotchas

**Segurança (ler antes de partilhar o URL):**

- A senha **é** o único gate: quem tem o URL completo usa o serviço até à revogação. O URL sem a senha é inútil (401). Gerar link novo (`new-link.sh`) ou parar o túnel para revogar — quem tinha o link antigo fica bloqueado no momento.
- Expor um servidor de **agent/admin/dashboard** publicamente continua a ser alto risco (a Elastic classifica a exposição via reverse tunnel de admin apps geridas por agentes como high severity — T1572); preferir uma preview build em vez de um dev server e manter sessões curtas.
- A fuga de source em dev servers é documentada, não teórica: `@cloudflare/vite-plugin` < 1.6.0 servia qualquer ficheiro da raiz do projeto (incluindo `.env`, `.dev.vars`) pelo dev server (CVE-2025-59427) — o gate protege o acesso, mas a superfície de exposição do próprio dev server é outra questão. Preferir uma **built preview** a `vite dev` para o que for partilhado.
- A URL pública **regenera-se a cada restart do cloudflared** — relê sempre a URL atual; as passwords criadas para a URL antiga morrem com ela.

**Limites dos quick tunnels (test/dev only):** não suportam SSE, limitam requests em voo a 200 (HTTP 429) e não têm SLA.

**WebSocket (verificado empiricamente):** ligações WS idle podem ser derrubadas (close 1006) após ~100 s em planos Free/Pro sem tráfego de protocolo e sem pings do servidor — apps com heartbeat ou reconnect do lado do cliente são a solução durável (em testes uma conexão idle sobreviveu 160 s; tratar drops como possíveis, não garantidos). Browsers enviam cookies no handshake WS (same-origin), por isso upgrades autenticados por cookie passam o gate — confirmado de ponta a ponta (101).

**Troubleshooting:**

| Sintoma | Causa / correção |
|---|---|
| `/` devolve **401** sem key/cookie | Esperado — o gate está ativo. ISTO é a proteção. |
| 401 num link que funcionava | O proxy reiniciou (token/sessões em memória perdidos) ou foi gerado link novo — corre `new-link.sh` e partilha o link fresco. |
| 401 na reutilização da mesma key | Só em modo single-use (`TOKEN_REUSE=0`) — é esse o modelo. A omissão é reutilizável. |
| Handshake WS devolve **426/502** nos testes | O cliente de teste negociou HTTP/2 e a edge removeu os headers de upgrade — re-testa com `curl --http1.1`. Browsers não são afetados. |
| WS rejeitado com sessão válida | Session cookie em falta no cliente de teste (cookies têm scope por host — usa o mesmo host + `-b jar`). Ou o proxy reiniciou (sessões em memória revogadas). |
| Path da app (ex. `/api`) devolve **403** com sessão viva | Host-validation fence — confirma que o cloudflared aponta para a porta do **proxy** (3100), não para a porta da app. |
| `proxy: EADDRINUSE` no log do proxy | Proxy antigo ainda a correr (pid stale). `bash scripts/expose-port/stop.sh` e repetir. |
| QR mostra texto de fallback | Falta o `qrencode` — `sudo apt install qrencode` (python3-qrcode é o segundo fallback). |
| O túnel nunca fica pronto | Vê o log do túnel — normalmente é um bloqueio de egress (é preciso outbound-only). |
| "websocket: bad handshake" nos logs do cloudflared | A origem recusou o upgrade — rejeição do gate (sem cookie) ou fence 403. Ver linhas acima. |

## Nota

`scripts/expose-port/README.md` é o documento original do projeto (proveniência); para operar, siga este módulo (caminhos já adaptados à skill unificada). Os ficheiros de estado (link atual e logs) vivem em `scripts/expose-port/`.
