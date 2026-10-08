# Expor URL/porta local (Cloudflare Tunnel)

Dois modos — escolha pelo pedido:

| Pedido | Modo | Comando |
|---|---|---|
| "publica/abre/converte esta URL **no meu Cloudflare / no meu domínio** (example.com…)", URL estável, "nunca derrube" | **1 — domínio próprio** (named tunnel) | `python3 scripts/expose-port/domain.py up '<url>'` |
| "manda-me um link rápido", sem conta/domínio, link temporário aleatório | **2 — quick tunnel** (`trycloudflare.com` + senha `?key=` + QR) | `bash scripts/expose-port/expose-port.sh <url>` |

## Modo 1 — domínio próprio (`domain.py`)

Um comando publica, outro derruba. Path, query e fragmento da URL local são **preservados**:
`http://127.0.0.1:3080/?token=XYZ` → `https://example.com/?token=XYZ` (ou `https://3080.example.com/?token=XYZ`).

```bash
python3 scripts/expose-port/domain.py up 'http://127.0.0.1:3080/?token=XYZ'            # domínio por omissão
python3 scripts/expose-port/domain.py up 'localhost:5173/app' --domain example.com --name app
python3 scripts/expose-port/domain.py up '<url>' --name @ --alias www --persist         # apex + www, sobrevive a reboot
python3 scripts/expose-port/domain.py up '<url>' --gate                                 # app SEM auth: senha ?key=
python3 scripts/expose-port/domain.py down app.example.com     # ou: down 5173 | down @ | down www | down all
python3 scripts/expose-port/domain.py list                   # rotas + cloudflared não geridos
python3 scripts/expose-port/domain.py purge example.com        # remove TUDO desta skill na zona
python3 scripts/expose-port/domain.py selftest               # offline
# atalho global equivalente: expose-port-cloudflare-agent-skill up|down|ls|purge …
```

Saída (contrato): `OK: publicado|atualizado|já estava no ar em N s`, bloco com host/upstream/
túnel/modo/verificação e, na última linha, **`URL=<url pública completa>`** — é essa que se
entrega. `--json` devolve o mesmo em JSON (`url`, `probe`, `down`…). Erros: `Erro: … —
Solução: …` (exit 1 operacional · 2 uso · 3 dependência/credencial).

**Host público**: `--name` (label; `@` = apex; FQDN da zona) > rota que já publica o mesmo
upstream (`localhost`/`127.0.0.1`/`::1` contam como o mesmo) > `<porta>.<domínio>`. Só um nível
abaixo da zona (o Universal SSL grátis cobre `*.zona`, não `a.b.zona`). **Domínio**: `--domain` >
`CLOUDFLARE_EXPOSE_DOMAIN` em `~/.config/cloudflare-agent-skill/config.env` > zona do
`cert.pem` > única zona ativa da conta (a escolha fica gravada em `config.env`).

### Arquitetura

```
Browser ── https://<host>.<zona>/?token=… ──► edge Cloudflare (TLS, HTTP/2, WS, SSE)
   *.zona (curinga, 1× por zona) e CNAMEs próprios (apex/www) → <túnel cfx-<zona>-<id>>.cfargotunnel.com
                                   ▼
     cloudflared (named tunnel cfx-<zona>-<id>, ingress catch-all → router; nunca reinicia por rota)
                                   ▼  http://127.0.0.1:<porta aleatória>
     zone-runner.mjs — router por Host (routes.json, reload por SIGHUP em ~50 ms):
       · Host → upstream loopback; Origin/Referer também quando são a origem pública da rota
         (Origin de terceiros passa intacto → CSRF da app continua a funcionar)
       · Location absoluto para o upstream → volta como https://<host>
       · ordem: /__cfx-health → gate TOTP (auth.json, opcional, §Gate TOTP) → gate ?key= →
         injecção ?token= (inject.json, só GET /) → proxy; WebSocket: TOTP + ?key=, nunca injeta
       · path/query/corpo/WebSocket/SSE verbatim · gate ?key= opcional · host sem rota → 404
                                   ▼
     a app local (intocada)
```

Estado em `~/.local/state/cloudflare-agent-skill/zones/<zona>/` (`zone.json`, `routes.json`,
`runtime.json`, `runner.log`, `creds.json` 0400 — e, se o overlay TOTP estiver ligado,
`auth.json`/`inject.json`/`auth-state.json`, §Gate TOTP). Processo: unit `systemd --user`
`cfx-zone@<zona>.service` (Restart=always); fica *enabled* (arranca no boot) só se houver rota
`--persist`. Rotas efémeras levam o `boot_id` e expiram no reboot. Sem rotas → processo parado.
Sem systemd → processo em background (`setsid`) e `--persist` recusado.

**Porquê um túnel por zona + curinga**: um hostname novo na Cloudflare leva **8–33 s** a ser
roteado pela edge (medido: autoritativo 7–19 s, edge 8–33 s), e recriar o mesmo host noutro
túnel deixa a edge a mandar para o túnel antigo (530) ~15–25 s. Com `*.zona` → túnel fixo,
um host novo é só uma rota local: **~0,06 s** na edge, `up` total ~0,7 s, `down` ~0,3 s.

### Gate TOTP (overlay opcional do zone-runner)

Autenticação TOTP (Google Authenticator) **à frente de todas as rotas da zona**, menos os hosts
em `exempt`. É um overlay do runner: `up`/`down` continuam a ser os únicos donos do
`routes.json`, e a configuração extra vive **fora** dele, em três ficheiros do zone-dir.

| Ficheiro (zone-dir) | Quem escreve | Quem lê | Conteúdo |
|---|---|---|---|
| `auth.json` | **utilizador**/`kluserme` | runner (watch 500 ms) | `enabled`, `totp.secret_hex` (40 hex), `totp.digits`/`period`/`skew`, `exempt: [hosts]` |
| `inject.json` | **utilizador**/`kluserme` | runner (watch 500 ms) | `routes.<host>.token` — token de boot injetado no `GET /` |
| `auth-state.json` | **runner** (único dono) | runner | `last_counter` (replay), `fails`/`fails_window_start` (rate-limit) |

O `domain.py` **nunca** lê nem escreve `auth.json`/`inject.json` (do zone-dir só usa
`/__cfx-health`): um `up` **substitui a entrada da rota por inteiro**, por isso tudo o que seja
configuração adicional tem de ficar fora do `routes.json` — dentro dele, o `up` seguinte
apagava-a. `auth-state.json` é escrito de forma **atómica** (`auth-state.json.tmp` + `rename`,
modo `0600`). `enabled: true` sem `secret_hex` de 40 hex (minúsculas) ⇒ TOTP desligado (fica
registado no `runner.log`); `digits` 6–8, `period` 1–3600 s, `skew` 0–3.

**Pipeline por request** (ordem exata): `/__cfx-health` (match exato do `req.url`, 200 — isento;
é o probe com que o `domain.py` prova a edge) → **gate TOTP** (host em `exempt` salta-o; sem
cookie de sessão: `GET`/`HEAD` → **401** com form que faz `POST /__cfx_totp__`, outros métodos →
401 seco; o `next` do form é sanitizado para path+query da própria origem) → gate `?key=`
existente → **injeção do `?token=`** → proxy. Upgrade **WebSocket**: TOTP primeiro (sem form —
401 direto) e depois `?key=`; **nunca injeta** token (o token tem de vir no próprio URL do WS).

**Injeção do token de boot** (`inject.json`): só em `GET`, com path **exatamente `/`**, sem
`?token=` já presente e **sem cookie `dsh-auth-*`** (a app DSH já tem sessão); o token é
acrescentado ao query original. Qualquer outro caso passa intacto — token em path ≠ `/` ou
duplicado faz o DSH responder **401/loop**. A injeção é só neste caminho HTTP: o upgrade
WebSocket nunca é tocado.

**Parâmetros Google Authenticator** (RFC 6238, HMAC-**SHA1**): **6 dígitos**, período **30 s** e
`bin % 10^digits` — ⚠️ **nunca** "os 6 primeiros dígitos do HOTP de 8 dígitos". Os seis vetores
do RFC Apêndice B em 8 dígitos passam, e os valores **corretos** de 6 dígitos são
`287082 · 081804 · 050471 · 005924 · 279037 · 353130` (truncar os 8 dígitos daria, p.ex.,
`653531` — incompatível com o Google Authenticator; há teste dedicado a esta divergência).
Desvio **±1** período (T-1/T/T+1). Sessão: cookie **`__cfx_totp`** (24 bytes aleatórios,
`HttpOnly; Secure; SameSite=Strict; Max-Age=43200` = **12 h**), guardado por host; mudar o
secret ou os parâmetros invalida **todas** as sessões.

**Abuso**: rate limit de **5 falhas/300 s → 403** (`muitas tentativas, aguarde`; um login
válido repõe o contador) e **replay global por secret** — o `last_counter` é único, logo dois
hosts com o mesmo secret **não podem usar o mesmo código no mesmo período de 30 s**
("código já usado — espera o próximo").

**Hot-reload**: `auth.json`/`inject.json` têm watch próprio de **500 ms** (o `SIGHUP`, que o
`domain.py` continua a mandar, recarrega os três) e editar qualquer deles **não** mexe no
`routes_version` — nenhum `up`/`down` fica pendente por causa do overlay.

### Tempos medidos (2026-09-26, zona Free)

| Operação | Tempo |
|---|---|
| 1º `up` numa zona (cria túnel + curinga) | ~9–10 s |
| `up` de host novo coberto pelo curinga | ~0,7 s (verificado pela edge) |
| `up` de rota existente (ex.: token novo) | ~0,2 s |
| `down` (rota → 404) / última rota (pára o processo) | ~0,2 s / ~0,3 s |
| `up` a frio (processo parado) | ~1,7 s |
| apex/`www`/nome com CNAME próprio novo | +8–33 s de propagação (a verificação espera) |
| trocar o CNAME de outro túnel para o nosso (`--force`) | a edge converge em 1–3 min; manter a origem antiga no ar até lá |

### Preparação automática (máquina nova)

Nada a instalar à mão: o `up` prepara o que faltar e `domain.py setup` faz o mesmo de forma
explícita, provando as permissões com testes reais e reversíveis (`setup --check` = só relatório,
`setup --deps` = só ferramentas). Sem sudo e sem perguntas:

| Falta | O que o script faz |
|---|---|
| `cloudflared` | binário oficial do release do GitHub, SHA256 do corpo do release, em `~/.local/bin` (macOS: `brew` se existir) |
| Node ≥ 18.13 | Node LTS de nodejs.org (`SHASUMS256.txt`) em `~/.local/share/cloudflare-agent-skill/` (privado) |
| credencial | `cloudflared tunnel login` em background + browser aberto; espera o `cert.pem` (exit **4** se o tempo acabar — o login continua vivo; autorizar e repetir) |
| domínio padrão | grava a zona autorizada (ou a única da conta) em `config.env` |
| linger (`--persist`) | `loginctl enable-linger` (ou `sudo -n`), só avisa se não der |

Único passo humano: no browser, escolher o domínio e clicar **Authorize** (a URL impressa abre
em qualquer aparelho — serve para servidores sem ecrã). O `cert.pem` chega para túnel + DNS
dessa zona; um token `CLOUDFLARE_API_TOKEN` com Zone·DNS·Edit + Account·Cloudflare Tunnel·Edit
também serve e cobre várias zonas. Requisitos que não se instalam sozinhos: `python3` ≥ 3.9 e
um domínio já ativo na Cloudflare (sem domínio → modo 2).

### Verificação feita pelo próprio `up`

Sem DNS recursivo (não semeia cache negativa em 1.1.1.1/ISP): pergunta o A record direto ao
nameserver autoritativo da zona, liga-se ao IP da edge com `curl --resolve`, confirma que a
edge chega a ESTE router (`/__cfx-health` → `x-cfx-proxy: ok`) e depois faz o GET real ao path.
`verificação HTTPS 401/200/303…` = a app respondeu; `app-down` = túnel OK mas nada escuta no
upstream (a URL funciona assim que a app subir); `edge-pendente`/`dns-pendente` = propagação
(repetir o `up`, é idempotente).

### Gotchas

- **Fence de Host/Origin** (Vite `allowedHosts`, apps que só confiam em loopback em `/api`):
  resolvido pela reescrita. Apps que precisam do host público (geram URLs absolutas a partir
  do `Host`): `--keep-host`.
- **Cookies**: a app vê `Host: 127.0.0.1:<porta>` — cookies "presos" à autoridade (apps que
  assinam a sessão com `127.0.0.1:<porta>`) continuam válidos pela URL pública.
- **App sem autenticação** num host previsível (`3000.zona`) = qualquer um usa. `--gate` põe a
  senha `?key=` (cookie HttpOnly/SameSite=Strict/Secure, WS incluído) à frente.
- **Registo DNS de terceiros** no nome pedido → erro com a solução (`--name` outro ou `--force`,
  que substitui o registo; um CNAME é PATCHado = troca atómica sem janela NXDOMAIN).
- `*.zona` já existente e não criado pela skill → a skill não mexe; cada host recebe CNAME
  próprio (volta a haver os 8–33 s por host novo). `CLOUDFLARE_EXPOSE_WILDCARD=0` força isso.
- `down` de host coberto pelo curinga deixa o nome a resolver (curinga) com **404** do router;
  de host com CNAME próprio apaga o CNAME. `purge` apaga curinga, CNAMEs e o túnel.
- Nunca montar à mão units/`config.yml`/proxies para isto — deixa a app exposta em sítios que
  a skill não conhece nem derruba (ver LEARNINGS 2026-09-26).
- Várias máquinas na mesma zona: cada uma tem o seu túnel (`cfx-<zona>-<id>`) e marca os seus
  registos (`cfx:<id>:`); só a primeira fica com o curinga — nas outras cada host novo leva
  CNAME próprio (8–33 s na 1ª vez). `<id>` = 6 hex do hash do machine-id (anónimo).

### Troubleshooting (modo 1)

| Sintoma | Causa / correção |
|---|---|
| `Erro: … já tem registo DNS que não é desta skill` | nome ocupado — outro `--name` ou `--force` |
| `o túnel da zona … não ficou pronto` | egress 7844 (UDP/TCP) bloqueado, túnel apagado fora daqui ou credencial inválida → `domain.py purge <zona>` e `up` de novo |
| `sem permissão para POST …/cfd_tunnel` (exit 3) | token sem Tunnel:Edit e sem `cert.pem` → `domain.py setup` (faz o login) |
| exit 4 `à espera da autorização no browser` | abrir a URL impressa, escolher o domínio, *Authorize*; repetir o comando |
| `a zona 'x' não é visível para token nem cert.pem` | o login autorizou outra zona → `domain.py setup --domain x` e escolher `x` no browser |
| `SHA256 não confere` no setup | download corrompido/adulterado — repetir; se persistir instalar à mão |
| `verificação … app-down` | a app local está parada; a URL funciona quando subir |
| 530 logo após `up` com `--force`/CNAME novo | propagação da edge (até ~3 min em troca de túnel) — o antigo continua a servir |
| 404 "Nada publicado em <host>" | host sem rota (curinga) — `domain.py list` |
| 403 nas rotas `/api` da app | a app precisa de `--keep-host`? (ou o contrário: foi publicada com `--keep-host`) |
| `list` mostra `expirada (reboot)` | rota efémera de um boot anterior — `up` de novo (ou `--persist`) |

## Modo 2 — quick tunnel com senha (sem conta, sem domínio)

Torna qualquer serviço local (`http://127.0.0.1:<port>` ou `http://localhost:<port>`) numa URL pública `https://*.trycloudflare.com` **protegida por senha**: a skill gera uma senha aleatória de 256 bits, acrescenta-a à URL (`?key=…`) e imprime o **link completo como QR code no terminal** — a pessoa digital e abre. Sem conta Cloudflare, sem domínio, sem DNS, sem alterar regras de firewall e **sem tocar no projeto servido** (todo o código de suporte vive ao lado, em `scripts/expose-port/`).

- Ninguém sem a senha acede (HTTP **e** WebSocket): pedidos sem a key e sem session cookie recebem **401**.
- A senha **vale até ser revogada** — reutilizável por omissão (um link preview, um segundo device ou uma reabertura nunca a queimam; `TOKEN_REUSE=0` restaura single-use). Ao abrir o link, o browser é redirecionado para a **URL limpa** (senha removida, `Referrer-Policy: no-referrer`) e recebe uma session cookie segura (HttpOnly, SameSite=Strict, Secure).
- **Nada expira sozinho**: sem TTL por omissão; as sessões duram até o proxy reiniciar (`TOKEN_TTL_MS`/`SESSION_TTL_MS` limitam opcionalmente). O link só deixa de funcionar quando é revogado (`new-link.sh`), o túnel é parado (`stop`/`stop-all`) ou os processos morrem. Uma senha nova pode ser gerada a qualquer momento com `new-link.sh` — a URL pública mantém-se.

### Quando usar (modo 2)

- Alguém precisa de um link público para um servidor local (dev UI, API, dashboard, preview build) e o acesso tem de ficar limitado a quem tem a senha.
- O serviço ouve apenas em `127.0.0.1`/`localhost` (os túneis funcionam na mesma — o cloudflared liga-se localmente).
- Não se pode modificar o projeto a expor (config, `allowedHosts`, etc.).

**Quando NÃO usar:**

- Há conta + domínio, ou o pedido diz "no meu Cloudflare/domínio" → **modo 1** (`domain.py`). Em produção, pôr **Cloudflare Access** (auth por identidade) à frente.
- Não há `node` disponível — o gate proxy (zero deps, `node:http/https`) precisa dele.
- O destinatário tem de ser uma **pessoa identificável que se possa revogar**: qualquer um com o link acede até gerar link novo (`new-link.sh`) ou parar o túnel.

### Procedimento (modo 2)

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

### Comandos (modo 2)

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

Named tunnel no domínio próprio: **não montar à mão** — é o modo 1 (`domain.py up`), que cria túnel, DNS, router e verificação num comando. Para identidade (SSO) por cima, pôr **Cloudflare Access** à frente do host publicado. Docs: <https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/>

### Gotchas (modo 2)

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

### Nota (modo 2)

`scripts/expose-port/README.md` é o documento original do projeto (proveniência); para operar, siga este módulo (caminhos já adaptados à skill unificada). Os ficheiros de estado (link atual e logs) vivem em `scripts/expose-port/`.
