# Cloudflare Sandbox — stable, `@next` (1.0 preview) e migração

Ambientes Linux isolados em [Cloudflare Containers](https://developers.cloudflare.com/containers/), dirigidos a partir de Workers. Este módulo cobre as duas linhas de pacote e a migração entre elas.

**Preferir sempre as docs oficiais e os types instalados à memória.** As skills originais são gates + contratos + retrieval maps, não manuais completos.

## Quando usar este módulo

| Situação | Modo |
|---|---|
| **App NOVA** (projeto novo) | **Modo `@next`** — recomendamos `@cloudflare/sandbox@next` (SDK 1.0 preview) para projetos novos. |
| **App EXISTENTE** no pacote estável (`@cloudflare/sandbox`) a manter/evoluir | **Modo stable** — pode ficar e continuar a fazer ship. |
| **Portar app stable → `@next`** (quando o utilizador pedir) | **Modo migração** — não forçar cutover sem pedido. |
| Limpeza de deprecated APIs **sem** sair do stable | Modo stable, com o [2026 deprecation guide](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/) — isso **não** é uma migração para `@next`. |
| Self-deployed **bridge** | **Sempre stable** — a bridge ainda não está na linha 1.0 preview. |

### Gate — confirmar a linha do pacote ANTES de escrever código

| Check | Stable | `@next` |
|---|---|---|
| npm dependency | `@cloudflare/sandbox` (sem `@next`/preview tags) | `@cloudflare/sandbox@next` (ou outro preview tag) |
| Container image | imagem **stable** correspondente (não `cloudflare/sandbox:next`) | mesma linha (`cloudflare/sandbox:next`, `next-python`) |

| Se encontrar… | Ação |
|---|---|
| `@cloudflare/sandbox@next` ou imagem `next` | **Parar.** Seguir o modo `@next` abaixo. |
| Pacote default sem `@next` | **Parar.** Seguir o modo stable abaixo. Não aplicar APIs `@next`. |
| Utilizador quer portar stable → `@next` | **Parar.** Seguir o modo migração abaixo. Não meio-aplicar preview APIs sobre pacote stable. |
| Só bridge self-deployed | Manter bridge em pacote + imagem stable. |

**Nunca misturar**: pacote Worker stable com imagem `@next`, nem o inverso.

## Procedimento

### Modo stable (apps no pacote estável)

Contrato não-negociável:

- `await sandbox.exec(command)` recebe uma **command string** e resolve quando o comando **termina**, com `stdout` / `stderr` / `exitCode` em buffer.
- Trabalho longo/streaming usa as APIs estáveis (`startProcess`, `execStream` e helpers relacionados) — **não** o single-handle model do `@next`. Não inventar handles `output()` do `@next` em stable.
- **Sessions** preservam working directory e ambiente entre comandos (`enableDefaultSession`, `createSession`).
- Terminais interativos no browser usam normalmente **`sandbox.terminal(request)`** e helpers session/xterm do stable.
- Preferir transporte **RPC** com tunnels ou streaming grande/binário. HTTP/WebSocket transports estão deprecated.
- Config não-secreta no sandbox env; credenciais vivas no Worker (outbound handlers para chamadas a APIs externas).
- Preview hostnames em produção precisam de wildcard DNS num custom domain.
- Não aplicar APIs argv/`process.output()` do `@next` enquanto a dependência for stable.

Shape mínimo:

```ts
import { getSandbox, proxyToSandbox, Sandbox } from "@cloudflare/sandbox";

export { Sandbox };

const sandbox = getSandbox(env.Sandbox, "user-123");
const result = await sandbox.exec('python3 -c "print(2 + 2)"');
// result.stdout, result.exitCode, result.success
```

Limpeza de deprecated APIs sem sair do stable — atualizar package + imagem correspondente primeiro e seguir o guia. Pesquisa típica:

```sh
rg 'SANDBOX_TRANSPORT|transport:|exposePort\(|enableDefaultSession|execStream\(|readFileStream|writeFileStream'
```

Checklist antes de ship: Worker package e container image na **mesma linha stable**; typecheck contra os types stable instalados; sem live secrets no sandbox env; concluir/tracked a limpeza [2026 deprecation](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/).

### Modo `@next` (apps no preview 1.0)

Contrato não-negociável:

- `sandbox.exec(argv)` recebe uma **argv list** e resolve quando o processo **arranca** — devolve um **handle**, não um resultado final.
- Colher resultados com os métodos do handle: `output()`, `logs()`, `waitForExit()`, `waitForPort()`, `waitForLog()`, `kill(signal?)`.
- **Sem shell implícito** — sintaxe shell exige shell explícito, ex.: `["/bin/bash", "-lc", script]`.
- Cada launch é independente: um `cd` / `export` num `exec` não é visível no seguinte. Passar `cwd` e `env` por launch, ou um único shell script.
- Process handles **não têm stdin** → interativo usa terminais (`createTerminal` + `connect`).
- `timeout` / `AbortSignal` locais cancelam **só a espera**, não matam o processo. Usar `kill` ou o `timeout` remoto do `exec`.
- `getProcess` / `listProcesses` / `getTerminal` / `listTerminals` **não arrancam** container; devolvem `null` / `[]` se não houver nenhum ativo.
- IDs de processos/terminais pertencem ao **container atual**, não eternamente ao sandbox ID. Trabalho que tem de sobreviver a replace: guardar o job completo (argv, cwd, env, estado), não só o id.
- Só config não-secreta em `setEnvVars` / launch `env`; credenciais vivas ficam no Worker.
- **Não inventar APIs removidas do stable** (`gitCheckout` no core, conclusão de string-`exec`, session execution, `sandbox.terminal(request)`), nem usar um único retry loop para todos os erros.

Shape mínimo:

```ts
import { getSandbox, proxyToSandbox, Sandbox } from "@cloudflare/sandbox";

export { Sandbox };

const sandbox = getSandbox(env.Sandbox, "user-123");
const process = await sandbox.exec(["python3", "-c", "print(2 + 2)"]);
const result = await process.output({ encoding: "utf8" });
// result.stdout, result.exitCode
```

Checklist antes de ship: lockfile e Dockerfile na **mesma** linha `@next`; typecheck contra types `@next`; sem live secrets no sandbox env; wildcard DNS para preview hostnames em produção.

### Modo migração (stable → `@next`)

**Executar** a migração pela ordem: **1) Review** das hard rules e do replacement map → **2) Audit** do codebase → **3) Clarify** com o utilizador → **4) Upgrade** de package, image e código → **5) Validate**. Parar após qualquer passo que precise de decisão do utilizador.

Hard rules:

- Worker package e container image têm de ser a **mesma** linha `@next`.
- Cutover em produção usa rollout **immediate** (`--containers-rollout=immediate`): os protocolos de controlo stable e `@next` são incompatíveis nos dois sentidos; rollout gradual deixa uma janela mista quebrada e pode parar trabalho em curso nos containers.
- Após o cutover, `await sandbox.exec(...)` significa processo **iniciado**, não comando **concluído**.
- Sem cutover de produção sem concordância do utilizador.

Replacement map (resumo):

| Stable | `@next` |
| --- | --- |
| `SANDBOX_TRANSPORT` / `transport` / `setTransport` | Remover — só RPC |
| `await sandbox.exec("cmd")` → resultado em buffer | `await sandbox.exec(argv)` → handle, depois `output` / waits |
| `execStream` / `startProcess` | Mesmo handle: `logs`, `waitFor*`, `kill` |
| Sessions default / named | Desapareceram — `cwd`/`env` por launch, ou um shell script |
| `sandbox.terminal(request)` / session terminal | `createTerminal` + `terminal.connect(request)` |
| xterm `sessionId` | `terminalId` |
| Interpreter methods em `Sandbox` | `withInterpreter` → `sandbox.interpreter.*` |
| `gitCheckout` | argv `git` via `exec` |
| Kill signals em string | Só numéricos |
| Files, mounts, backups, ports, tunnels, `proxyToSandbox` | Quase inalterado (ignorar session/transport das páginas stable) |

Auditoria (também: string `exec(`, `cd` e um `exec` posterior, `createCodeContext` / `runCode` bare em `Sandbox`):

```sh
rg 'SANDBOX_TRANSPORT|transport:|setTransport|enableDefaultSession|createSession|getSession|deleteSession|execStream\(|startProcess\(|killProcess\(|sandbox\.terminal\(|sessionId|gitCheckout\(|SandboxTransport|ExecutionSession'
```

Upgrade de package e image:

```sh
npm install @cloudflare/sandbox@next
```

```dockerfile
FROM cloudflare/sandbox:next
# Python: cloudflare/sandbox:next-python
```

Shapes de código (aplicar o map e implementar a partir das docs, não de hábitos stable):

```ts
// Before (stable)
const result = await sandbox.exec("npm test");

// After (@next)
const process = await sandbox.exec(["/bin/bash", "-lc", "npm test"]);
const result = await process.output({ encoding: "utf8" });
```

```ts
const server = await sandbox.exec(["/bin/bash", "-lc", "npm run dev"], {
  cwd: "/workspace/app",
});
await server.waitForPort(3000, { timeout: 60_000 });
await server.kill(); // numeric; default 15
```

```ts
const terminal = await sandbox.createTerminal({ command: ["bash"], cwd: "/workspace" });
const t = await sandbox.getTerminal(terminal.id);
if (!t) return new Response("terminal gone", { status: 410 });
return t.connect(request, { cursor, cols, rows });
```

```ts
import { Sandbox as BaseSandbox } from "@cloudflare/sandbox";
import { withInterpreter } from "@cloudflare/sandbox/interpreter";

export class Sandbox extends BaseSandbox<Env> {
  interpreter = withInterpreter(this);
}
```

```ts
const clone = await sandbox.exec(
  ["git", "clone", "--depth", "1", "--", repoUrl, "/workspace/repo"],
  { cwd: "/workspace" },
);
const result = await clone.output({ encoding: "utf8" });
```

Deploy/cutover: primeiro em staging/branch; produção é **um** deploy de Worker + image compatíveis:

```sh
npx wrangler deploy --containers-rollout=immediate
```

Deixar `rollout_active_grace_period` no default `0`. Após o cutover, IDs de processos/terminais pré-deploy ficam inválidos.

Validação final: lockfile + Dockerfile na mesma linha `@next`; typecheck contra `@next`; smoke de argv `exec` + `output({ encoding: "utf8" })`; smoke de processo longo/terminal/interpreter se usados; erros distinguíveis (unavailable / interrupted-RPC / stale / local wait); sem live secrets no sandbox env; grep final a APIs removidas; produção usou `--containers-rollout=immediate`.

## Conhecimento essencial

Red flags — parar e corrigir (qualquer modo):

- Misturar Worker `@next` com imagem stable (ou o inverso).
- Rollout gradual de containers neste cutover (exige `--containers-rollout=immediate`).
- Tratar `await exec` como conclusão de comando no `@next`.
- Assumir que `cd` / exports persistem entre chamadas `exec` no `@next`.
- Um único retry wrapper para todos os erros (ver Errors docs do `@next`).
- Inventar `gitCheckout`, stdin de processos ou APIs não documentadas.
- Manter IDs de processos/terminais pré-cutover depois do deploy.
- Forçar cutover de produção sem concordância do utilizador.
- Pôr live secrets em `setEnvVars` / launch `env` (ambas as linhas).
- Aplicar deprecated-API cleanup (2026) e assumir que isso migra para `@next` — não migra.

## Referências rápidas

| Tema | Ficheiro de detalhe |
|---|---|
| API `@next` por tarefa (Processes, Terminals, Interpreter, Lifecycle, Errors, Environment) | `references/upstream/sandbox-next/references/api-quick-ref.md` |
| Índice de examples `@next` (branch `next`: minimal, code-interpreter, agent harnesses, terminals, mounts, multi-user) | `references/upstream/sandbox-next/references/examples.md` |
