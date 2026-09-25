# Cloudflare API v4 — mapa de endpoints (referência nível 3)

Base: `https://api.cloudflare.com/client/v4` · Auth: `Authorization: Bearer <CLOUDFLARE_API_TOKEN>`
Envelope de resposta: `{"success": bool, "errors": [{code,message}], "messages": […], "result": …, "result_info": {page,per_page,total_count,total_pages}}`.

Use `scripts/cf-api.sh <MÉTODO> <caminho> ['<json>']` — ele valida o envelope e
traduz erros para `Erro/Solução`. Docs completas: <https://developers.cloudflare.com/api/>

## Zonas e DNS

```bash
GET    /zones?name=example.com                  # resolver zone id + status
POST   /zones                                   # { "name": "example.com", "account": {"id": …} }
GET    /zones/<zone_id>
PATCH  /zones/<zone_id>                         # { "paused": false }
DELETE /zones/<zone_id>
GET    /zones/<zone_id>/dns_records?per_page=100
POST   /zones/<zone_id>/dns_records             # {type,name,content,ttl,proxied}
PATCH  /zones/<zone_id>/dns_records/<rec_id>
DELETE /zones/<zone_id>/dns_records/<rec_id>
GET    /zones/<zone_id>/dns_records/export      # BIND format
POST   /zones/<zone_id>/dns_records/import      # import BIND
```

Status de zona relevantes: `pending` (nameservers por propagar) → `active`;
`initializing`/`moved`/`deactivated` ver troubleshooting.

## Contas e tokens

```bash
GET    /accounts                                # account ids (para CLOUDFLARE_ACCOUNT_ID)
GET    /accounts/<acc_id>
GET    /user/tokens/verify                      # valida o token do env (doctor usa)
GET    /user/tokens                             # lista tokens (sem valores!)
POST   /user/tokens                             # criar token por API (escopos em auth-and-tokens.md)
PUT    /user/tokens/<token_id>                  # editar permissões
DELETE /user/tokens/<token_id>
GET    /accounts/<acc_id>/tokens/permission_groups   # ids dos grupos de permissão
```

## Workers e Pages

```bash
GET    /accounts/<acc_id>/workers/scripts                    # lista workers
PUT    /accounts/<acc_id>/workers/scripts/<name>             # upload (multipart)
DELETE /accounts/<acc_id>/workers/scripts/<name>
GET    /accounts/<acc_id>/workers/scripts/<name>/settings     # bindings via API
GET    /accounts/<acc_id>/pages/projects
POST   /accounts/<acc_id>/pages/projects
POST   /accounts/<acc_id>/pages/projects/<proj>/deployments   # deploy por API (multipart)
GET    /accounts/<acc_id>/pages/projects/<proj>/domains       # domínios custom
POST   /accounts/<acc_id>/pages/projects/<proj>/domains       # { "name": "www.example.com" }
```

## Regras, WAF e SSL

```bash
GET    /zones/<zone_id>/rulesets                       # phase entries
POST   /zones/<zone_id>/rulesets                       # criar ruleset
GET    /zones/<zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint
GET    /zones/<zone_id}/pagerules
POST   /zones/<zone_id>/pagerules                      # { targets, actions }
GET    /zones/<zone_id}/settings/ssl                   # off | flexible | full | strict
PATCH  /zones/<zone_id>/settings/ssl                   # { "value": "strict" }
GET    /zones/<zone_id>/settings/always_use_https
PATCH  /zones/<zone_id>/settings/always_use_https      # { "value": "on" }
GET    /zones/<zone_id>/ssl/verification
```

## Zero Trust / Access (resumo)

```bash
GET    /accounts/<acc_id>/access/apps
POST   /accounts/<acc_id>/access/apps                  # app protegido por Access
GET    /accounts/<acc_id>/access/policies
POST   /accounts/<acc_id>/access/policies
GET    /accounts/<acc_id>/gateway/locations
```
Detalhe Zero Trust: usar a skill oficial `cloudflare-one` (instalada em `~/.agents/skills`).

## Analytics / uso

```bash
GET    /zones/<zone_id>/analytics/dashboard
GET    /accounts/<acc_id>/storage/analytics            # R2 usage
```

## Erros API mais comuns (código → significado)

| code | significado | ação |
|---|---|---|
| 10000 | autenticação/permissão | token inválido ou escopo em falta |
| 7003 | query inválida | conferir parâmetros |
| 1049 | item não existe | conferir ids |
| 81044 | zona não ativa | concluir ativação (nameservers) |
| 9106 | feature paga | limites do plano Free |
| 91098002 | validação do corpo | conferir campos do JSON |
