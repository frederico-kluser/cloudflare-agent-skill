# Cloudflare One — Zero Trust e SASE

## Quando usar este módulo

Use este módulo para **projetar, configurar, diagnosticar ou revisar** implementações Cloudflare One (Zero Trust / SASE): Access, Gateway, WARP/device client, Tunnel/Mesh, Cloudflare WAN, DLP, CASB, device posture e identidade.

- Migração a partir de VPN/SWG/SASE de outro vendor → `references/zero-trust-migrations.md`.
- Endpoints Zero Trust via Cloudflare API v4 → `references/api-v4.md`.
- **Antes de citar limites, definições, campos de API, category IDs ou caminhos exatos da UI**, obter a informação atual na [Cloudflare One docs](https://developers.cloudflare.com/cloudflare-one/), no Cloudflare docs MCP server ou no schema da Cloudflare API. Nunca adivinhar.

## Procedimento

Fluxo de trabalho para qualquer pedido (arquitetura, configuração, troubleshooting, migração ou revisão):

1. **Classificar** o pedido: arquitetura, configuração, troubleshooting, migração ou revisão.
2. **Recolher contexto**: account ID, users/sites/apps, identity provider, SCIM/group sync, device management, caminho de tráfego, restrições de compliance e blast radius do rollout.
3. **Obter só as docs atualizadas** dos produtos envolvidos: Access, Gateway, WARP/device client, Tunnel/Mesh, Cloudflare WAN, DLP, CASB, device posture ou identidade.
4. **Inspecionar os recursos existentes** antes de propor/alterar (se houver acesso à conta): Access apps/policies/groups/IdPs, Gateway rules/lists/categories, device profiles/posture checks, tunnels/routes, DNS/resolver settings e locations/sites.
5. **Propor o change set** com pré-requisitos, validação e rollback. Alterações de risco: stage disabled ou limitado a piloto (grupo/site), salvo pedido explícito em contrário.

### Assessment prompts (avaliar antes de configurar)

**Arquitetura e estado atual** — sites e users (escritórios, data centers, VPCs, remote users, contractors, modelo de conectividade); aplicações/destinos (SaaS, apps públicos/privados, APIs, protocolos, portas, hostnames, IP ranges); conectividade (VPN, MPLS, SD-WAN, breakout, backhaul, site-to-site, private DNS); security stack atual (SWG, NGFW, VPN/ZTNA, DLP, CASB, email security, logging, compliance); identidade (IdP, SCIM/group sync, naming de grupos, multi-IdP, service accounts, contractors); rollout (pilot users/sites, blast radius, rollback, support owners, success criteria).

**Access e SaaS federation** — forma da app (web app, API, SSH/RDP/VNC, database, SaaS, public hostname, private IP ou private hostname); modelo de acesso (clientless browser access, private networking com device client, peer-to-peer, service connections com service tokens ou mTLS, SaaS SSO federation); políticas (user groups, device posture, session duration, mTLS, service tokens, visibilidade no app launcher); SaaS (SAML vs OIDC, ACS/redirect URLs, Entity IDs/client IDs, atributos, tenant-control).

**Tunnel e private networking** — sites/segmentos que precisam de conectividade; HA (dev/test com um connector, produção com múltiplos, redundância avançada); runtime do cloudflared ou WARP Connector/Mesh (VM, container, Kubernetes, bare metal); egress do connector; reachability das origins privadas; routing (CIDRs/hostnames, IP spaces sobrepostos, virtual networks, Split Tunnels, private DNS/resolver policies); modelo de gestão — **preferir remotely managed/token-based tunnels** para novas implementações.

**Gateway, TLS e DLP** — controlos de tráfego (DNS categories, HTTP URL/path inspection, L4 ports/protocols, egress IP, custom lists, exceções allow/block); seletores de identidade; TLS inspection (root CA, certificate pinning, exceções de compliance, FIPS); DLP (data types, canais, readiness de TLS inspection, DLP profiles, payload logging, tolerância a falsos positivos).

**CASB, device posture e risk** — CASB (vendors SaaS, nível de admin access, scan policy, tamanho, dono da remediação, proteção inline); device posture (checks, integrações EDR/MDM, enrollment rules, device profiles, split tunnel); risk scoring (behavior signals, falsos positivos, investigação vs enforcement).

**Cloudflare WAN / site connectivity** — topologia, tipo de on-ramp, ownership de rotas, redundância de tunnels, rotas static vs BGP, network firewall, appliances/profiles.

### Mapa de retrieval (obter a doc certa antes de configurar)

| Área | Doc a consultar antes de agir |
|---|---|
| Tipo de aplicação Access | [Access application type](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/) |
| Seletores / ordem de avaliação de políticas | [Access policy](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) |
| Pré-checks de conectividade de tunnels | [Tunnel connectivity prechecks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/) |
| Virtual networks / Split Tunnels / private DNS | [Tunnel virtual networks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/tunnel-virtual-networks/) · [Split Tunnels](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/route-traffic/split-tunnels/) · [Resolver policies](https://developers.cloudflare.com/cloudflare-one/traffic-policies/resolver-policies/) |
| Seletores e ordem de enforcement do Gateway | [Gateway traffic policy](https://developers.cloudflare.com/cloudflare-one/traffic-policies/) · [Order of enforcement](https://developers.cloudflare.com/cloudflare-one/traffic-policies/order-of-enforcement/) · [Identity selectors](https://developers.cloudflare.com/cloudflare-one/traffic-policies/identity-selectors/) · [SCIM provisioning](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/scim/) |
| TLS decryption / DLP / CASB findings / risk score | [TLS decryption](https://developers.cloudflare.com/cloudflare-one/traffic-policies/http-policies/tls-decryption/) · [DLP](https://developers.cloudflare.com/cloudflare-one/data-loss-prevention/) · [CASB findings](https://developers.cloudflare.com/cloudflare-one/cloud-and-saas-findings/manage-findings/) · [User risk score](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/risk-score/) |
| Private apps / infra SSH | [Self-hosted private app](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/self-hosted-private-app/) · [Infrastructure apps](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/infrastructure-apps/) · [Browser rendering](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/browser-rendering/) · [Short-lived certificates](https://developers.cloudflare.com/cloudflare-one/identity/users/short-lived-certificates/) |
| Device client / MDM | [Device client](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/) · [MDM deployment](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/mdm-deployment/) |
| Conectar private hostname | [Connect a private hostname](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-private-hostname/) |
| Logs / analytics / DEX / Logpush | [Gateway logs](https://developers.cloudflare.com/cloudflare-one/analytics/logs/gateway-logs/) · [Access authentication logs](https://developers.cloudflare.com/cloudflare-one/insights/logs/dashboard-logs/access-authentication-logs/) · [Shadow IT discovery](https://developers.cloudflare.com/cloudflare-one/insights/analytics/shadow-it-discovery/) · [DEX](https://developers.cloudflare.com/cloudflare-one/insights/dex/) · [DEX tests](https://developers.cloudflare.com/cloudflare-one/insights/dex/tests/) · [Logpush](https://developers.cloudflare.com/cloudflare-one/analytics/logs/logpush/) |
| WAN / Network Firewall / on-ramps | [Cloudflare WAN](https://developers.cloudflare.com/cloudflare-wan/) · [Cloudflare Network Firewall](https://developers.cloudflare.com/cloudflare-network-firewall/) · [Choose an on-ramp](https://developers.cloudflare.com/learning-paths/secure-internet-traffic/connect-devices-networks/choose-on-ramp/) |

### Validação por área

- **Access**: testar fluxos authorized, unauthorized, posture-failing, service-token e multi-IdP; inspecionar logs e precedência de políticas. Políticas novas: verificar que são geridas pela reusable policy collection e não aparecem como `reusable: false` app-scoped.
- **Private network access**: route lookup, tunnel health, origin reachability, split tunnel behavior, DNS resolution e acesso end-to-end a partir de um device client de teste.
- **Gateway**: rule type, action, traffic expression, fase de precedência/evaluation, lists referenciadas e settings — antes de ativar em larga escala.
- **TLS/DLP**: testar exceções Do Not Inspect e trust da root CA antes de ativar inspeção; testar DLP com amostras conhecidas e monitorizar falsos positivos antes de bloquear.
- **CASB/risk**: health da integração, expiração de credenciais, asset discovery, scan timing, finding instances e latência do risk score.
- **Cloudflare WAN**: tunnel health, prioridade/ownership de rotas, fluxo de tráfego, sintaxe das expressões de firewall, telemetria de connectors/appliances.

### Formato de output

- **Designs**: premissas atuais, arquitetura-alvo, responsabilidades por produto, fases de rollout, validação e decisões em aberto.
- **Configuração**: pré-requisitos, recursos exatos a inspecionar/criar/alterar, test cases e rollback.
- **Troubleshooting**: caminho de tráfego, ponto provável de falha, evidência a recolher e próximo teste.

## Conhecimento essencial

### Guardrails gerais

- **Access controla autorização de aplicações; Gateway controla inspeção/filtragem de tráfego.** Usar ambos quando o requisito abranger acesso identity-aware + segurança de rede/web.
- Em implementações Access novas, criar políticas pela reusable policy API (`/access/policies`) e anexá-las às aplicações. **Não enviar `policies` inline** num create/update de aplicação, salvo documentação atual que o exija explicitamente.
- Política app-scoped com `reusable: false` = **legacy**. Migrar via endpoint documentado `make_reusable` ou substituir por reusable policies; não criar novas legacy. Não confundir com o tipo de app legacy private-network (deprecated).
- Public hostname Access apps podem ser clientless. Apps com private destination exigem WARP/Device client (ou outro on-ramp) + routes + resolução DNS.
- **Cloudflare Tunnel é um off-ramp** de uma private network para a Cloudflare. Cloudflare WAN e Mesh são outros off-ramps que também podem ser on-ramps.
- Políticas baseadas em grupos dependem de IdP group claims ou SCIM. Sem group sync, **não inventar seletores de grupo**.
- Private hostnames precisam de DNS routing/resolution explícito: criar uma Access app sozinha não chega. Usar [resolver policies](https://developers.cloudflare.com/cloudflare-one/traffic-policies/resolver-policies/).
- HTTP inspection e DLP para tráfego web encriptado exigem TLS inspection e exceções Do Not Inspect planeadas.
- Gateway DNS, Network, HTTP e Egress policies têm semânticas de avaliação diferentes — consultar [order of enforcement](https://developers.cloudflare.com/cloudflare-one/traffic-policies/order-of-enforcement/) antes de explicar precedência.
- Políticas block/allow/DLP/TLS amplas: começar **disabled**, limitadas a piloto com users/grupos específicos, salvo aprovação de rollout mais amplo.
- **Nunca adivinhar** category IDs, application IDs, wirefilter fields ou request bodies — obter schema/docs atuais e objetos existentes da conta. Não ativar políticas amplas em produção sem aprovação explícita. Usar nomes fully qualified de tools MCP quando disponíveis.

### Identidade e Access

- **Access Groups são objetos Cloudflare**; grupos IdP/SCIM são identity claims. Os seletores de grupo do Gateway usam grupos IdP sincronizados, **não** Access Groups.
- Nomes de grupos e atributos SAML/OIDC são **case-sensitive** — verificar claim names/values exatos.
- SCIM/membership podem estar stale até sync + re-autenticação. Diagnosticar com a última identidade autenticada do user.
- Políticas Access são **default-deny**: uma private app com routes mas sem Allow policy continua bloqueada.
- Seletores de política Access usam IP lists, não Gateway domain/URL lists.
- SaaS federation trata da autenticação; autorização/tenant restrictions no SaaS exigem roles no lado SaaS e/ou Gateway tenant controls.
- **Browser Rendering para SSH/VNC/RDP** é uma capability do Access; **Browser Isolation** renderiza conteúdo web geral remotamente. Não confundir.

### Device client (WARP) deployment

- O [Cloudflare One device client](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/) é o on-ramp dos dispositivos. Dois controlos: **enrollment rules** (quem pode ligar) e **device profiles** (comportamento após enrollment).
- A enrollment rule é uma Access application do tipo `warp` (aceita reusable Access policies) — debugar em **Access**, não em Devices.
- Dispositivos headless/autónomos (serviços, kiosks, Linux hosts): service token enrollment. Autenticam como `non_identity@[team-domain].cloudflareaccess.com`, sem group membership — profiles que usam grupos IdP não os apanham. Alvejar explicitamente pelo email non-identity, convenções de dispositivo (OS) ou deixá-los cair no default profile.
- Device profiles controlam connection mode, split tunnel config, permissões do user (disable, switch lock), auto-reconnect e captive portal. Matching por grupo ou atributos de device, **first match wins**; o default profile apanha o resto.
- **Split tunnel mode é a definição de client mais impactante:**

  | Objetivo | Modo | Racional |
  |---|---|---|
  | Só substituição de VPN (private apps) | **Include** | Encaminhar só os CIDRs/hostnames privados pelo client; resto vai direto. Blast radius mínimo. |
  | Só SWG (internet security) | **Exclude** | Todo o tráfego pelo client; excluir só o que parte (printers locais, certificate-pinned apps). |
  | VPN replacement + SWG | **Exclude** | Todo o tráfego pelo client. Configuração enterprise mais comum. |
  | Coexistência com outro VPN | **Include** | Evita conflito com a tunnel interface e controlo de DNS do outro VPN. |
  | Só DNS filtering | DNS-only mode | Só queries DNS para o Gateway; sem proxying de tráfego. |

- Include vs Exclude é **por profile**, não por entrada — não se misturam modos no mesmo profile. Mudar de modo a meio do deployment obriga a reavaliar todas as entradas.
- Split tunnel entries e tunnel routes têm de alinhar **bidirecionalmente**: CIDR no include sem tunnel route = black hole; tunnel route sem entrada no profile = tráfego nunca entra no tunnel.
- MDM parameters (`mdm.xml` / managed preferences) **sobrepõem-se** às definições do dashboard para qualquer setting especificado. Se mudanças no dashboard não fazem efeito, verificar MDM.
- Outro VPN client/agent que controlo DNS no device conflita com a DNS interception do client. Em coexistência, usar modo "traffic only".
- Captive portal detection (hotel/airport WiFi) desliga temporariamente o client — fonte comum de fricção.

### Private networking

- O modo de split tunnel muda o significado de cada decisão de routing: **Exclude** envia tráfego à Cloudflare quando removido dos excludes; **Include** envia apenas quando adicionado aos includes.
- **Virtual networks** principalmente quando há sobreposição de subnets e não se usa routing por hostname. Para outros comportamentos, preferir security policies.
- Um tunnel healthy só prova que o cloudflared alcança a Cloudflare — são necessárias application routes, network routes ou hostname routes publicadas.
- Para SSH com o device client, preferir **Zero Trust Infrastructure Access (ZTIA)**: keystroke logging, controlo de autenticação, [short-lived certificates](https://developers.cloudflare.com/cloudflare-one/identity/users/short-lived-certificates/) (CA configurada no host + `sshd` a confiar na Cloudflare CA public key) e privileged access management leve.
- **Browser Rendering** dá SSH/RDP/VNC clientless pelo browser (RDP com session recording e file transfer controls) — usar quando não é possível instalar o device client (contractors, partners, unmanaged devices), não como default para users managed.
- **Audit SSH** é uma Gateway Network policy action que regista comandos SSH sem bloquear; exige sessão proxyada pela Cloudflare.
- Para kubectl e bases de dados em private networks: device client com private destination routing — não existe equivalente ZTIA/browser para TCP arbitrário.
- Vários connectors cloudflared para HA em produção, de preferência em hosts separados. **Token-based, remotely managed tunnels** são o default para novas implementações.
- Cloudflare WAN é **conectividade, não um serviço de segurança** — aplicar inspeção/política com Gateway e Network Firewall. WAN firewall expressions ≠ wirefilter do Gateway. IPsec PSKs gerados e alguns OAuth/client secrets são devolvidos **uma única vez** — guardar já.

### Gateway, TLS e DLP

- `dns.domains` casa com domínio **e subdomínios**; `dns.fqdn` é **exact-match only**.
- Seletores DNS de pre-resolution e post-resolution não formam uma lista estrita de precedência única — consultar docs atuais antes de mudar ordem.
- Regras **Do Not Inspect** correm antes do comportamento HTTP Allow/Block/Isolate — uma block rule posterior não anula um bypass de inspeção anterior.
- Apps certificate-pinned precisam de exceções Do Not Inspect **antes** de TLS inspection ampla; fazer deploy da Cloudflare root CA aos devices managed primeiro.
- **DLP profiles são só definições de deteção**: não fazem nada até serem referenciadas por Gateway HTTP policies ou CASB scan settings. Regras com body inspection podem ser avaliadas várias vezes numa passagem.
- Começar DLP com payload logging, afinar falsos positivos, **depois** bloquear.
- Gateway Network policies são controlos L4 estritos; matching L4 com identidade requer contexto autenticado de device.

### CASB, risk e operações

- API CASB é **out-of-band e periódica** — não dá enforcement inline em tempo real; para isso usar [granular application controls](https://developers.cloudflare.com/cloudflare-one/traffic-policies/http-policies/granular-controls/) do Gateway para apps SaaS suportados.
- CASB findings estão ligados a assets/instancias específicos — inspecionar os ativos afetados antes de recomendar remediação. A maioria das remediações faz-se na consola admin do SaaS, não na Cloudflare.
- Integrações SaaS grandes podem demorar **24-48h** no scan inicial; reautorizar reinicia o scan state — verificar credential health antes de reconectar.
- User risk scores são behavior-based e assíncronos; findings CASB não implicam automaticamente alto risco do user.

### Logs, analytics e DEX

- **Gateway activity logs** (DNS/HTTP/Network): ferramenta principal de troubleshooting do tipo "why was this blocked/allowed" — filtrar por rule name, user identity, destination, action, time range.
- **Access audit logs**: decisões de autenticação por app (quem, que política, sessão) — para verificar comportamento de políticas e investigar falhas.
- **Shadow IT discovery** usa HTTP logs do Gateway; requer TLS inspection para visibilidade HTTPS.
- **DEX (Digital Experience Monitoring)**: diagnósticos por fleet/device; usar DEX tests (HTTP, traceroute) para monitorizar reachability a origins críticas. Fleet status mostra health do client, connection mode e connectivity.
- **Logpush** exporta logs Gateway/Access/Network/DEX para SIEM/storage externo — configurar **antes do go-live** se houver retenção centralizada/compliance.
- No troubleshooting, **trabalhar dos logs para a config**: identificar a entrada de log do erro (Gateway block, Access deny, tunnel error, DNS resolution miss) e rastrear até à regra/rota/política responsável.

## Referências rápidas

| Tema | Ficheiro de detalhe |
|---|---|
| Migração de VPN/SWG/SASE → Cloudflare One (assessment, policy mapping, paridade, rollout) | `references/zero-trust-migrations.md` |
| Endpoints Zero Trust/Access na Cloudflare API v4 (resumo + erros) | `references/api-v4.md` |
