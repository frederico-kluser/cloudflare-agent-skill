# Cloudflare One — Migações (VPN / SWG / SASE → Cloudflare One)

## Quando usar este módulo

Use este módulo para **avaliar e planear migrações** de plataformas VPN, SWG ou SASE existentes para o Cloudflare One: Zscaler ZIA/ZPA, Palo Alto NGFW/Prisma/GlobalProtect, VPN/SWG/SD-WAN legacy ou outras — incluindo policy mapping, gaps de paridade e rollout.

- Conceitos de produtos Cloudflare One (Access, Gateway, WARP, Tunnel, DLP, CASB) → `references/zero-trust.md`.
- Endpoints Zero Trust/Access via API v4 → `references/api-v4.md`.
- **Antes de gerar configuração exata**, obter as docs Cloudflare atuais, os schemas da Cloudflare API e os docs de export do vendor de origem.

## Procedimento

1. **Identificar a stack de origem**: Zscaler ZIA, Zscaler ZPA, Palo Alto NGFW/Prisma/GlobalProtect, VPN/SWG/SD-WAN legacy, ou outra.
2. **Pedir exports e logs antes de mapear**. Preferir exports estruturados a screenshots ou resumos em prosa.
3. **Construir um inventário**: identities, groups, apps, destinations, connectors/tunnels, políticas DNS/URL/firewall/DLP/TLS, objects/lists, locations/sites, exceções, hit counts e compliance logging.
4. **Produzir um mapping plan**: source object, resource-alvo Cloudflare One, confiança, pré-requisitos, mappings não suportados/parciais e decisões manuais.
5. **Criar primeiro as dependências**: identity/[SCIM](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/scim/), connectors/on-ramps, routes/DNS, lists/objects, TLS bypasses, Access apps/policies, Gateway policies, DLP/CASB, logging.
6. **Staging seguro**: usar um migration prefix, criar regras disabled/audit-mode por default, pilotar com grupos/sites pequenos, comparar logs e só depois expandir o rollout.
7. **Contabilizar TODAS as regras de origem**: cada regra tem de mapear para um objeto Cloudflare ou para uma linha explícita **Not Migrated** com motivo e impacto em segurança.

### Exports a pedir

- **ZIA**: URL filtering, firewall filtering, SSL inspection, DLP, custom URL categories, IP groups, network services/service groups, users/groups/departments, locations, GRE tunnels, static IPs.
- **ZPA**: app segments, segment groups, server groups, app connectors/connector groups, access policies, IdP/group mapping, private DNS domains, ports, protocols.
- **Palo Alto/Prisma**: security/NAT/decryption rules, address/service objects e groups, URL categories, HIP profiles, config GlobalProtect, Prisma Access remote network/service connection, zones, tags, logs, hit counts.

### Assessment prompts

- **Cobertura de origem**: produtos em scope, exports disponíveis, e se screenshots/prosa estão a esconder falta de object files.
- **Volume de regras e hit data**: contagens por tipo, regras disabled/stale, regras sem hits, regras de alto hit, exceções business-critical.
- **Dependências de objetos**: address objects, service objects, groups, custom categories, network services, app IDs, zones, tags, connectors, server groups.
- **Identity readiness**: IdP, SCIM/group sync, normalização de nomes de grupos, regras por user individual, local groups, service accounts, identidades de contractor.
- **TLS/DLP readiness**: regras de decryption na origem, bypasses certificate-pinned, engines/profiles [DLP](https://developers.cloudflare.com/cloudflare-one/data-loss-prevention/), custom regex, exact-match data, expectativas de payload logging.
- **Connectivity readiness**: tunnels/connectors de origem, private DNS, comportamento [Split Tunnels](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/route-traffic/split-tunnels/) ou bypass, preservação de source IP, allowlists de [egress IP](https://developers.cloudflare.com/cloudflare-one/traffic-policies/egress-policies/), requisitos site-to-site.
- **Rollout readiness**: pilot groups/sites, período de parallel-run, dono do rollback, critérios de decomission da stack de origem, plano de monitorização/comparação de logs.

## Conhecimento essencial

### Heurísticas de mapeamento

- Políticas ZIA/SWG mapeiam normalmente para [Gateway traffic policies](https://developers.cloudflare.com/cloudflare-one/traffic-policies/) e Gateway lists.
- ZPA private app access mapeia normalmente para [Access application types](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/), [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), private network routing/DNS e [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).
- Regras Palo Alto só mapeiam depois de entender direção de tráfego, zones, objects, users, apps, decryption e hit counts. **Não achatar zones cegamente em lists**.
- Substituição de VPN legacy: normalmente Access + Cloudflare One Client / WARP + Tunnel ou Mesh para acesso a apps. Usar [Cloudflare WAN](https://developers.cloudflare.com/cloudflare-wan/) **apenas** quando houver tráfego site-to-site; ver [Network VPN migration design guide](https://developers.cloudflare.com/reference-architecture/design-guides/network-vpn-migration/) e [Replace your VPN](https://developers.cloudflare.com/cloudflare-one/setup/replace-vpn/).

### Armadilhas por vendor — Zscaler ZIA / SWG

- Custom URL categories dividem-se muitas vezes em lists separadas de IP, domínio e URL. **Contar as lists geradas**, não só as categorias de origem.
- Locations ZIA com IPs servem como source IP lists; **não** se tornam automaticamente [Gateway DNS locations](https://developers.cloudflare.com/cloudflare-one/networks/resolvers-and-proxies/dns/locations/) para scoping de políticas DNS.
- Source IPs de GRE tunnels podem informar condições de política, mas a migração do transporte é um workstream separado (WARP Connector ou Cloudflare WAN).
- Comportamento CAUTION/warn **não tem equivalente exato** no Gateway — tratar como decisão explícita do cliente, não como allow/block silencioso.
- DLP engines e custom regex exigem normalmente recriação manual de DLP profiles na Cloudflare. **Políticas placeholder não podem ser ativadas como se o DLP estivesse completo.**
- Network application groups e protocolos não suportados são mappings parciais — rever antes de enablement.
- Sem SCIM, as regras de origem scoped por identidade ficam demasiado amplas, salvo alternativa exequível (ex.: lists de user/email). Ver [Gateway identity selectors](https://developers.cloudflare.com/cloudflare-one/traffic-policies/identity-selectors/).

### Armadilhas por vendor — Zscaler ZPA / Private Access

- App segments, server groups e connector groups do ZPA **não mapeiam 1:1** — a Cloudflare separa Access apps, tunnel routes, DNS e políticas.
- Criar tunnels via API **não completa o deployment do connector** — planear instalação do cloudflared, autenticação e origin reachability separadamente.
- **Um Cloudflare Tunnel por ZPA connector group**, independentemente do estado do runtime (AUTHENTICATED, DISCONNECTED ou disabled) — estado é operacional, não arquitetónico. Marcar grupos disconnected/legacy na descrição do tunnel e deixar o cliente decidir o que decomissionar.
- Cada ZPA connector instance dentro de um grupo → **uma réplica cloudflared** a correr com o token desse tunnel. Igualar o número de réplicas ao de connector instances por grupo. Um tunnel token suporta vários processos cloudflared simultâneos; instalar réplicas no mesmo data center mas em hosts/subnets diferentes.
- Por connector group: identificar todos os server groups ligados e todos os app segments atribuídos. IPs/CIDRs dos app segments → CIDR routes no tunnel correspondente; domínios → hostname routes no mesmo tunnel. **Preferir uma CIDR route por subnet** a rotas /32 por host.
- Bypass ZPA = **split-tunnel bypass** na Cloudflare, não uma decisão Access `bypass`. Regras de bypass mapeiam para entradas **exclude** do WARP [Split Tunnel](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/route-traffic/split-tunnels/) — passo manual sem automação API: o cliente adiciona domínios/IPs à exclude list do device profile via dashboard.
- Apps agentless/browser podem virar public-hostname Access apps por domínio; apps WARP privados mantêm-se como private-destination apps.
- O limite default de destinos por Access app é **5 hostnames**. Em migrações ZPA com app segments grandes, pedir aumento à account team (até 50) **antes** da implementação e confirmar que está ativo na conta; caso contrário, segmentos grandes têm de se partir em múltiplas apps com políticas idênticas.
- Apps IP-anchored exigem uma **decisão de egress explícita** antes da migração: preservar source IP via egress do cliente, usar Cloudflare [dedicated egress](https://developers.cloudflare.com/cloudflare-one/traffic-policies/egress-policies/) onde existir, ou aceitar que o serviço-alvo tem de permitir novos source IPs. Decisão do cliente que **bloqueia a implementação** se não resolvida.
- Resolver policies podem ser account-wide — cuidado com namespaces private DNS sobrepostos entre sites/virtual networks; ver [resolver policy](https://developers.cloudflare.com/cloudflare-one/traffic-policies/resolver-policies/) antes de alterar DNS.
- Cada regra de access policy ZPA → uma Cloudflare **reusable Access policy** (criar todas antes de anexar a apps). Em ambientes Gateway Network default-deny, criar adicionalmente uma Network allow rule com selector "Self-hosted Access App with Private Address is Present" (wirefilter: `any(access.private_app[*] in {"*"})`) **com precedência superior** a quaisquer broad L4 block rules — sem ela, o Gateway bloqueia o tráfego de private apps antes da avaliação das políticas Access.
- Em migrações ZIA+ZPA combinadas, as Gateway Network rules podem bloquear tráfego Access private-app sem querer — a allow rule acima é a correção; colocá-la com precedência mais alta (número mais baixo) que as block rules migradas do ZIA e validá-la **antes** de ativar broad L4 blocks.

### Armadilhas por vendor — Palo Alto / Prisma / NGFW

- Uma regra Palo Alto pode produzir **vários** recursos Cloudflare — preservar a intenção da regra, não a contagem.
- App-ID, URL category, zone, HIP, schedule e decryption raramente traduzem exatamente — marcar mappings parciais em vez de forçar falsa equivalência.
- Exportar address/service objects e groups **com as regras** — exports de objetos em falta causam drops de aspeto silencioso.
- Regras `any` amplas e CIDRs muito abrangentes exigem revisão manual. **Não auto-criar broad catchalls.**
- HIP/device checks exigem integrações [device posture](https://developers.cloudflare.com/cloudflare-one/reusable-components/posture-checks/) antes do enforcement.

### Gotchas transversais

- Os exports frequentemente separam referências por ficheiros — resolver IDs contra os ficheiros de objects, services e groups **antes** de declarar uma regra unmappable.
- Users individuais, local groups, departments e dynamic application IDs precisam frequentemente de identity normalization; SCIM/group sync é o pré-requisito gating para seletores de grupo.
- Caution/warn do Zscaler, App-ID do Palo Alto e exceções TLS/decryption podem não ter equivalentes exatos — marcar como **decision points**, não forçar 1:1.
- Preservar ordem e hit counts das regras de origem quando existirem. Desativar/apagar regras stale/sem hits **apenas com aprovação do utilizador**.
- **Nunca criar broad allow-all catchalls** para preservar conectividade, salvo pedido explícito e com limite de tempo.

### Validation gates

- Após cada fase, comparar contagens de objetos Cloudflare com as contagens parseadas da origem — **parar em mismatches**.
- Rever todos os itens `unsupported`, `partial`, `unmapped`, `needs_identity`, `needs_posture` e `manual_review` antes de ativar políticas.
- Validar group matching com users reais do piloto **depois** de SCIM sync e re-autenticação.
- Testar TLS inspection e comportamento Do Not Inspect antes de ativar blocks HTTP/DLP em larga escala.
- Rollback explícito: desativar regras migradas por prefixo, restaurar routing de origem ou reverter o pilot group/site.
- Antes de declarar conclusão, produzir uma **source-rule accounting table**: objeto migrado, mapping parcial, motivo de não-migração, impacto em segurança e dono de cada ação manual.

### Template de assessment

```markdown
## Migration Assessment

Source stack:
Artifacts reviewed:
Assumptions / missing exports:
Recommended Cloudflare One target:
Mapping summary:
Risks / partial mappings:
Not migrated:
Pilot plan:
Validation:
Rollback:
```

## Referências rápidas

| Tema | Ficheiro de detalhe |
|---|---|
| Arquitetura, guardrails e troubleshooting Cloudflare One (Access, Gateway, WARP, Tunnel, DLP, CASB) | `references/zero-trust.md` |
| Endpoints Zero Trust/Access na Cloudflare API v4 (resumo + erros) | `references/api-v4.md` |
