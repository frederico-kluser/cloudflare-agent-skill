# Wrangler — enciclopédia de comandos (referência nível 3)

Instalação local (recomendada por projeto): `npm i -D wrangler` · global: `npm i -g wrangler`.
Sempre que aqui aparecer `wrangler`, pode substituir por `npx wrangler`.
Docs: <https://developers.cloudflare.com/workers/wrangler/>

## Projeto e arranque

```bash
wrangler init <nome>            # template interativo (hello-world, TS…)
wrangler dev                    # runtime local (workerd, SEM conta Cloudflare)
wrangler dev --port 8787 --local
wrangler deploy                 # build + deploy atómico global
wrangler deploy --dry-run --outdir dist   # validação de bundle sem publicar
wrangler versions upload        # versão + preview URL (CI/CD)
wrangler rollback [version_id]  # rollback instantâneo
wrangler delete                 # apaga o worker (confirmação)
wrangler tail                   # logs em tempo real (requer auth)
wrangler tail --format json     # logs para processamento determinístico
```

## Segredos e variáveis

```bash
echo "valor" | wrangler secret put NOME        # pipe: NUNCA em linha de comando/histórico
wrangler secret list
wrangler secret delete NOME
# Vars públicas → [vars] no wrangler.toml (entram via deploy)
```

## Workers (API de bindings)

```toml
# wrangler.toml
[placement]            # Smart Placement: reposiciona o isolate por latência
mode = "smart"

[[kv_namespaces]]
binding = "MEU_KV"
id = "<kv-namespace-id>"

[[d1_databases]]
binding = "MEU_DB"
database_name = "meu-db"
database_id = "<d1-id>"

[[r2_buckets]]
binding = "MEU_BUCKET"
bucket_name = "meu-bucket"

[[queues.producers]]
binding = "MINHA_FILA"
queue = "minha-fila"

[[durable_objects.bindings]]
name = "MEU_DO"
class_name = "MeuDO"
```

## KV

```bash
wrangler kv namespace create "NOME"          # imprime id → wrangler.toml
wrangler kv key put --namespace-id=<id> "chave" "valor"
wrangler kv key get --namespace-id=<id> "chave"
wrangler kv key list --namespace-id=<id>
wrangler kv key delete --namespace-id=<id> "chave"
```

## D1 (SQL)

```bash
wrangler d1 create <nome-da-db>
wrangler d1 execute <nome-da-db> --command "CREATE TABLE …"
wrangler d1 execute <nome-da-db> --file=./schema.sql
wrangler d1 execute <nome-da-db> --remote --command "SELECT …"   # produção
wrangler d1 export <nome-da-db> --output=dump.sql
wrangler d1 info <nome-da-db>
```

## R2 (S3-compatible)

```bash
wrangler r2 bucket create <nome>
wrangler r2 bucket list
wrangler r2 object put <bucket>/caminho/ficheiro --file=./local.bin
wrangler r2 object get <bucket>/caminho/ficheiro --file=./saida.bin
wrangler r2 object delete <bucket>/caminho/ficheiro
```

## Queues e Durable Objects

```bash
wrangler queues create <nome>
wrangler queues list
# DO: classe em src + [[durable_objects.bindings]] + [[migrations]] no toml
```

## Pages (frontend estáticos / full-stack)

```bash
wrangler pages project create <nome> --production-branch=main
wrangler pages deploy <dir> --project-name=<nome>
wrangler pages deployment list --project-name=<nome>
wrangler pages secret put <NOME> --project-name=<nome>
```

## Conta e diagnóstico

```bash
wrangler whoami                 # identidade/contas (não mostra token)
wrangler types                 # gera tipos para bindings
CLOUDFLARE_API_TOKEN=… wrangler deploy   # auth por env (CI)
```

## Limites e notas (plano Free)

| Recurso | Limme típico Free |
|---|---|
| Worker size | 3 MB gzipped |
| KV | 1 GB, 100k leituras/dia |
| D1 | 5 GB, 5M leituras/dia |
| R2 | 10 GB, 1M Class A/mês |
| Pages | 500 builds/mês |
| Requests | 100k/dia |

(Confirmar sempre em <https://developers.cloudflare.com/workers/platform/limits/> — mudam.)
