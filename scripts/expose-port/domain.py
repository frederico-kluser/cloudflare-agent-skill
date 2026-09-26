#!/usr/bin/env python3
"""domain.py — publica uma URL local no SEU domínio Cloudflare e derruba num comando.

Uso:
  domain.py up <url> [--domain D] [--name N] [--alias A]... [--persist] [--keep-host]
                     [--gate] [--force] [--json] [--qr]
  domain.py down <alvo>... | all [--json]    alvo = host (app.example.com), label (app, @, www) ou porta
  domain.py list [--json]
  domain.py setup [--check | --deps] [--domain D] [--json]
                                              prepara a máquina: instala o que faltar, faz login, testa permissões
  domain.py purge <zona> | all [--json]      remove TUDO desta skill na zona (túnel, *.zona, registos)
  domain.py selftest                          offline, sem rede

<url>: http://127.0.0.1:3080/?token=X · localhost:5173/app · https://127.0.0.1:9443 · 8080.
Path, query e fragmento são PRESERVADOS: http://127.0.0.1:3080/?token=X → https://<host>/?token=X.

Preparação automática (sem perguntar): falta cloudflared → binário oficial (SHA256) em ~/.local/bin;
falta Node ≥18.13 → Node LTS oficial (SHA256) numa pasta privada; sem credencial → `cloudflared
tunnel login` com o browser aberto (único passo humano: escolher o domínio e clicar Authorize — o
cert.pem resultante chega para túnel + DNS dessa zona; token de API é opcional).

Host público: --name (label, '@' = apex, ou FQDN da zona) > rota já publicada para o mesmo
upstream (reutilizada, instantâneo) > '<porta>.<domínio>'. Domínio: --domain >
CLOUDFLARE_EXPOSE_DOMAIN (~/.config/cloudflare-agent-skill/config.env) > zona do cert.pem > única
zona ativa (a escolha fica gravada em config.env).

Arquitetura: 1 túnel nomeado por zona (cfx-<zona>) + CNAME curinga *.<zona> → túnel (criado
uma vez) + zone-runner.mjs (router por Host + cloudflared). Um share novo é só uma rota: não
há DNS para propagar (host novo responde em ~0,1 s; sem curinga a Cloudflare leva 8–33 s).
Apex (@) e nomes com registo explícito recebem um CNAME próprio. `down` tira a rota (404 na
hora) e apaga CNAMEs próprios; sem rotas o processo pára. Efémero por omissão (a rota morre
no reboot); --persist = sobrevive a reboot (unit systemd --user cfx-zone@<zona>).

Exit: 0 ok · 1 erro operacional (Erro/Solução) · 2 uso inválido · 3 dependência/credencial em falta
      · 4 à espera de ação humana (autorizar o login no browser)
"""
import argparse
import base64
import fcntl
import hashlib
import http.client
import json
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = HERE / "zone-runner.mjs"
SELF = Path(__file__).resolve()
API = "https://api.cloudflare.com/client/v4"
_XDG_CONFIG = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
CONF_DIR = _XDG_CONFIG / "cloudflare-agent-skill"
CONFIG_FILE = CONF_DIR / "config.env"
ROOT = Path(os.environ.get("CFX_STATE_DIR") or (
    Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "cloudflare-agent-skill"))
ZONES = ROOT / "zones"
ZONE_CACHE = ROOT / "zone-ids.json"
DATA_DIR = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "cloudflare-agent-skill"
PRIVATE_BIN = DATA_DIR / "bin"
USER_BIN = Path.home() / ".local" / "bin"
UNIT_DIR = _XDG_CONFIG / "systemd" / "user"
UNIT_TEMPLATE = "cfx-zone@.service"
ENV_KEYS = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_EXPOSE_DOMAIN", "CLOUDFLARE_EXPOSE_WILDCARD")
LOOPBACK = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
PROBE_FAIL = {"000", "502", "503", "504", "530"}
AUTH_CODES = {10000, 10001, 9103, 9109, 6003, 6111}
LABEL_RE = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
NODE_MIN = (18, 13)
JSON_OUT = False
PREFERRED_CRED = None


def machine_tag():
    """6 hex anónimos e estáveis desta máquina (hash — o id bruto nunca sai daqui). Separa túneis e
    registos DNS de várias máquinas do mesmo utilizador na mesma zona."""
    seed = None
    for f in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        try:
            seed = Path(f).read_text().strip() or None
        except OSError:
            pass
        if seed:
            break
    if not seed and shutil.which("ioreg"):  # macOS
        out = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], capture_output=True, text=True).stdout
        m = re.search(r'"IOPlatformUUID" = "([^"]+)"', out)
        seed = m.group(1) if m else None
    return hashlib.sha256((seed or socket.gethostname()).encode()).hexdigest()[:6]


MACHINE = machine_tag()
DNS_COMMENT = f"cfx:{MACHINE}: cloudflare-agent-skill domain.py (remover: domain.py down/purge)"


class Fail(Exception):
    def __init__(self, erro, solucao, code=1, kind=None):
        super().__init__(erro)
        self.erro, self.solucao, self.code, self.kind = erro, solucao, code, kind


def die(erro, solucao, code=1, kind=None):
    raise Fail(erro, solucao, code, kind)


def say(msg=""):
    if not JSON_OUT:
        print(msg, flush=True)


def warn(msg):
    if not JSON_OUT:
        print("AVISO: " + msg, file=sys.stderr, flush=True)


def human(msg):
    """Pedido de ação humana: vai sempre para stderr (visível também em --json)."""
    print(msg, file=sys.stderr, flush=True)


# ------------------------------------------------------------ credenciais ---
def load_env():
    """Env tem precedência; depois credentials.env (segredos) e config.env (preferências)."""
    files = [os.environ.get("CLOUDFLARE_CREDENTIALS_FILE") or CONF_DIR / "credentials.env", CONFIG_FILE]
    for f in files:
        try:
            lines = Path(f).read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if line.startswith("export "):
                line = line[7:].strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k in ENV_KEYS and not os.environ.get(k):
                os.environ[k] = v


def write_config(key, value):
    """Grava KEY=value em config.env (preferências, sem segredos) — substitui a linha se existir."""
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    try:
        lines = CONFIG_FILE.read_text().splitlines()
    except OSError:
        lines = ["# Preferências da cloudflare-agent-skill (sem segredos) — gerado por domain.py setup."]
    lines = [ln for ln in lines if not re.match(rf"^\s*(export\s+)?{key}=", ln)] + [f"{key}={value}"]
    fd = os.open(CONFIG_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.environ[key] = value


def cert_file():
    return Path(os.environ.get("TUNNEL_ORIGIN_CERT") or Path.home() / ".cloudflared" / "cert.pem")


def cert_info():
    """{accountID, zoneID, apiToken} do cert.pem do `cloudflared tunnel login` — só em memória, nunca impresso."""
    try:
        txt = cert_file().read_text()
        m = re.search(r"-----BEGIN ARGO TUNNEL TOKEN-----(.*?)-----END ARGO TUNNEL TOKEN-----", txt, re.S)
        return json.loads(base64.b64decode("".join(m.group(1).split()))) if m else None
    except (OSError, ValueError, AttributeError):
        return None


def cred_candidates():
    """Credenciais por ordem: token de API (env/credentials.env), depois o token do cert.pem
    (vale para túneis da conta e DNS da zona que foi autorizada no login)."""
    out = []
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        out.append(("token", os.environ["CLOUDFLARE_API_TOKEN"]))
    cert = cert_info()
    if cert and cert.get("apiToken"):
        out.append(("cert.pem", cert["apiToken"]))
    return out


def _call(token, method, path, body=None, params=None):
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(
        url, method=method, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json",
                 "User-Agent": "cloudflare-agent-skill-domain/3"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.load(e)
        except Exception:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        die(f"sem rede para api.cloudflare.com ({e})", "verificar conectividade/proxy e repetir")


def api(method, path, body=None, params=None):
    """Cloudflare API v4 com fallback entre credenciais: um erro de autenticação passa à seguinte."""
    cands = cred_candidates()
    if not cands:
        die("nenhuma credencial Cloudflare nesta máquina (sem CLOUDFLARE_API_TOKEN e sem ~/.cloudflared/cert.pem)",
            f"python3 {SELF} setup — abre o login no browser; basta escolher o domínio e clicar Authorize", 3, "auth")
    if PREFERRED_CRED:
        cands.sort(key=lambda c: c[0] != PREFERRED_CRED)
    tried = []
    for label, tok in cands:
        status, doc = _call(tok, method, path, body, params)
        if doc.get("success"):
            return doc
        errs = doc.get("errors") or [{}]
        codes = {e.get("code") for e in errs}
        tried.append(f"{label}: {errs[0].get('code')} {errs[0].get('message', 'HTTP %s' % status)}")
        if status in (401, 403) or codes & AUTH_CODES:
            continue
        err = errs[0]
        hints = {
            81053: "já existe registo A/AAAA/CNAME com esse nome — outro --name, ou --force para substituir",
            81057: "registo idêntico já existe — repetir o up (é idempotente)",
            1049: "recurso não existe — conferir zona/ids (domain.py list)",
        }
        die(f"Cloudflare API {method} {path} → {err.get('code')}: {err.get('message', 'sem detalhe')}",
            hints.get(err.get("code"), "ver references/troubleshooting.md"))
    die(f"sem permissão para {method} {path} ({'; '.join(tried)})",
        f"python3 {SELF} setup — refaz o login (cloudflared tunnel login) na zona certa; ou dar ao token "
        "Zone·DNS·Edit + Account·Cloudflare Tunnel·Edit (references/auth-and-tokens.md)", 3, "auth")


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def zone_info(domain):
    """(zone_id, account_id) + fixa a credencial que enxerga a zona. Cache local (ids não mudam)."""
    global PREFERRED_CRED
    hit = (read_json(ZONE_CACHE, {}) or {}).get(domain)
    if hit and hit.get("name_servers") and hit.get("cred"):
        PREFERRED_CRED = hit["cred"]
        return hit["zone_id"], hit["account_id"]
    found, labels = None, []
    for label, tok in cred_candidates():
        labels.append(label)
        _, doc = _call(tok, "GET", "/zones", params={"name": domain})
        res = (doc.get("result") or []) if doc.get("success") else []
        if len(res) == 1:
            found = (label, res[0])
            break
    if not found:
        if not labels:
            api("GET", "/zones")  # levanta o erro "nenhuma credencial" com a solução
        die(f"a zona '{domain}' não é visível para {' nem '.join(labels)}",
            f"autorizar esta zona: python3 {SELF} setup --domain {domain} (login no browser escolhendo {domain}); "
            "ou usar um token com acesso a ela", 3, "auth")
    label, z = found
    if z.get("status") != "active":
        die(f"zona '{domain}' está '{z.get('status')}'", "concluir a troca de nameservers antes de publicar")
    cache = read_json(ZONE_CACHE, {}) or {}
    cache[domain] = {"zone_id": z["id"], "account_id": z["account"]["id"],
                     "name_servers": z.get("name_servers") or [], "cred": label}
    write_json(ZONE_CACHE, cache)
    PREFERRED_CRED = label
    return z["id"], z["account"]["id"]


def active_zones():
    names = []
    for _, tok in cred_candidates():
        _, doc = _call(tok, "GET", "/zones", params={"status": "active", "per_page": 50})
        names += [z["name"] for z in (doc.get("result") or []) if doc.get("success")]
    return sorted(set(names))


def cert_zone_name():
    cert = cert_info()
    if not (cert and cert.get("zoneID")):
        return None
    _, doc = _call(cert["apiToken"], "GET", f"/zones/{cert['zoneID']}")
    return (doc.get("result") or {}).get("name") if doc.get("success") else None


def resolve_domain(arg, name=None, remember=True):
    d = (arg or "").strip().lower().rstrip(".")
    if d:
        return d
    if name and "." in name.strip(".") and name != "@":
        n = name.strip().lower().rstrip(".")
        for z in sorted(active_zones(), key=len, reverse=True):
            if n == z or n.endswith("." + z):
                return z
    d = (os.environ.get("CLOUDFLARE_EXPOSE_DOMAIN") or "").strip().lower().rstrip(".")
    if d:
        return d
    d = cert_zone_name()
    if not d:
        zones = active_zones()
        if len(zones) != 1:
            die(f"domínio não indicado e há {len(zones)} zonas ativas ({', '.join(zones) or '—'})",
                "passar --domain <zona> (fica gravado em config.env para as próximas vezes)", 2)
        d = zones[0]
    if remember:
        write_config("CLOUDFLARE_EXPOSE_DOMAIN", d)
    return d


# ---------------------------------------------------------- ferramentas ---
def find_tool(name):
    for d in (None, PRIVATE_BIN, USER_BIN):
        if d is None:
            p = shutil.which(name)
            if p:
                return p
        elif (d / name).is_file() and os.access(d / name, os.X_OK):
            return str(d / name)
    return None


def http_get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "cloudflare-agent-skill-setup"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_verified(url, sha256):
    try:
        data = http_get(url, timeout=600)
    except (urllib.error.URLError, OSError) as e:
        die(f"download falhou: {url} ({e})", "verificar a rede e repetir", 3)
    if sha256 and hashlib.sha256(data).hexdigest() != sha256.lower():
        die(f"SHA256 não confere para {url}", "download corrompido/adulterado — repetir; se persistir instalar à mão", 3)
    return data


def install_cloudflared():
    if platform.system() == "Darwin" and shutil.which("brew"):
        subprocess.run(["brew", "install", "cloudflared"], capture_output=True, text=True)
        if find_tool("cloudflared"):
            say(f"  instalado: cloudflared (brew) → {find_tool('cloudflared')}")
            return find_tool("cloudflared")
    mach = platform.machine().lower()
    arch = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64",
            "armv7l": "arm", "armv6l": "arm", "i386": "386", "i686": "386"}.get(mach)
    system = platform.system()
    if system == "Linux" and arch:
        asset = f"cloudflared-linux-{arch}"
    elif system == "Darwin" and arch in ("amd64", "arm64"):
        asset = f"cloudflared-darwin-{arch}.tgz"
    else:
        die(f"sem binário oficial do cloudflared para {system}/{mach}",
            "instalar à mão: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/", 3)
    tag, sha = None, None
    try:  # o corpo do release publica "<asset>: <sha256>"
        rel = json.loads(http_get("https://api.github.com/repos/cloudflare/cloudflared/releases/latest", 20))
        tag = rel.get("tag_name")
        m = re.search(rf"^{re.escape(asset)}:\s*([0-9a-f]{{64}})\s*$", rel.get("body") or "", re.M)
        sha = m.group(1) if m else None
    except Exception:
        pass
    url = (f"https://github.com/cloudflare/cloudflared/releases/download/{tag}/{asset}" if tag
           else f"https://github.com/cloudflare/cloudflared/releases/latest/download/{asset}")
    data = fetch_verified(url, sha)
    USER_BIN.mkdir(parents=True, exist_ok=True)
    dest, tmp = USER_BIN / "cloudflared", USER_BIN / ".cloudflared.download"
    if asset.endswith(".tgz"):
        tmp.write_bytes(data)
        with tarfile.open(tmp) as tf:
            member = next(m for m in tf.getmembers() if m.isfile() and m.name.rstrip("/").endswith("cloudflared"))
            data = tf.extractfile(member).read()
        tmp.unlink()
    tmp.write_bytes(data)
    tmp.chmod(0o755)
    os.replace(tmp, dest)
    if subprocess.run([str(dest), "--version"], capture_output=True).returncode != 0:
        die(f"o cloudflared descarregado não executa ({dest})", "instalar à mão (ver URL da documentação oficial)", 3)
    say(f"  instalado: cloudflared {tag or 'latest'} → {dest}" + ("" if sha else " (sem SHA256 publicado)"))
    return str(dest)


def node_version(path):
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"v(\d+)\.(\d+)", out.strip())
    return (int(m.group(1)), int(m.group(2))) if m else None


def install_node():
    system, mach = platform.system(), platform.machine().lower()
    os_tag = {"Linux": "linux", "Darwin": "darwin"}.get(system)
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64", "armv7l": "armv7l"}.get(mach)
    if not (os_tag and arch):
        die(f"sem Node oficial para {system}/{mach}", "instalar Node.js ≥ 18.13 à mão (https://nodejs.org)", 3)
    try:
        ver = next(r for r in json.loads(http_get("https://nodejs.org/dist/index.json", 30)) if r.get("lts"))["version"]
        sums = http_get(f"https://nodejs.org/dist/{ver}/SHASUMS256.txt", 30).decode()
    except Exception as e:
        die(f"não consegui consultar nodejs.org ({e})", "verificar a rede ou instalar Node.js ≥ 18.13 à mão", 3)
    name = f"node-{ver}-{os_tag}-{arch}"
    fname = name + (".tar.xz" if os_tag == "linux" else ".tar.gz")
    m = re.search(rf"^([0-9a-f]{{64}})\s+{re.escape(fname)}$", sums, re.M)
    data = fetch_verified(f"https://nodejs.org/dist/{ver}/{fname}", m.group(1) if m else None)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DATA_DIR / (fname + ".download")
    tmp.write_bytes(data)
    shutil.rmtree(DATA_DIR / name, ignore_errors=True)
    try:
        with tarfile.open(tmp) as tf:
            tf.extractall(DATA_DIR, **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
    except (tarfile.TarError, OSError):  # python sem lzma → tar do sistema
        subprocess.run(["tar", "-xf", str(tmp), "-C", str(DATA_DIR)], check=True)
    tmp.unlink()
    PRIVATE_BIN.mkdir(parents=True, exist_ok=True)
    link = PRIVATE_BIN / "node"
    link.unlink(missing_ok=True)
    link.symlink_to(DATA_DIR / name / "bin" / "node")
    say(f"  instalado: node {ver} → {DATA_DIR / name} (privado da skill)")
    return str(link)


def ensure_cloudflared():
    return find_tool("cloudflared") or install_cloudflared()


def ensure_node():
    for p in (find_tool("node"), str(PRIVATE_BIN / "node")):
        if p and Path(p).exists() and (node_version(p) or (0, 0)) >= NODE_MIN:
            return p
    return install_node()


def open_browser(url):
    if platform.system() == "Linux" and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return False
    try:
        return webbrowser.open(url)
    except Exception:
        return False


def login_flow(timeout=300):
    """`cloudflared tunnel login` em background + browser aberto; espera o cert.pem. O login fica
    vivo depois do timeout (o utilizador pode autorizar mais tarde e repetir o comando)."""
    if cert_file().is_file():
        return
    cf = ensure_cloudflared()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log, pidf = DATA_DIR / "login.log", DATA_DIR / "login.pid"
    pid = (pidf.read_text().strip() if pidf.exists() else "") or None
    if not pid_alive(pid, "cloudflared"):
        with open(log, "w") as lf:
            p = subprocess.Popen([cf, "tunnel", "login"], stdout=lf, stderr=subprocess.STDOUT,
                                 stdin=subprocess.DEVNULL, start_new_session=True)
        pidf.write_text(str(p.pid))
    url, t0 = None, time.time()
    while not url and time.time() - t0 < 20:
        m = re.search(r"https://dash\.cloudflare\.com/argotunnel\S+", log.read_text(errors="replace") if log.exists() else "")
        url = m.group(0) if m else None
        if not url:
            time.sleep(0.3)
    if not url:
        die("cloudflared tunnel login não mostrou a URL de autorização", f"ver {log}", 3)
    opened = "should have opened" in log.read_text(errors="replace") or open_browser(url)
    human("\nAÇÃO NO BROWSER (único passo manual): escolha o domínio e clique Authorize.\n"
          + ("  (o browser foi aberto; se não apareceu, abra a URL abaixo — serve qualquer aparelho)\n" if opened
             else "  Abra esta URL em qualquer aparelho com sessão na Cloudflare:\n")
          + f"  {url}\n")
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cert_file().is_file():
            say(f"  login concluído: {cert_file()} (túneis + DNS da zona autorizada)")
            return
        time.sleep(1)
    die(f"à espera da autorização no browser há {timeout} s",
        f"abrir {url}, escolher o domínio e clicar Authorize; depois repetir o comando (o login continua ativo)", 4, "login")


# ------------------------------------------------------------------ estado ---
def parse_target(raw):
    s = raw.strip()
    if re.fullmatch(r"\d{1,5}", s):
        s = f"http://127.0.0.1:{s}/"
    elif not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", s):
        s = "http://" + s
    u = urllib.parse.urlsplit(s)
    if u.scheme not in ("http", "https"):
        die(f"esquema '{u.scheme}' não suportado em '{raw}'", "usar http:// ou https://", 2)
    if not u.hostname:
        die(f"URL sem host: '{raw}'", "ex.: http://127.0.0.1:3080/?token=…", 2)
    try:
        port = u.port
    except ValueError:
        die(f"porta inválida em '{raw}'", "ex.: http://127.0.0.1:3080", 2)
    default = 443 if u.scheme == "https" else 80
    port = port or default
    host = "127.0.0.1" if u.hostname == "0.0.0.0" else u.hostname
    authority = f"[{host}]" if ":" in host else host
    upstream = f"{u.scheme}://{authority}" + ("" if port == default else f":{port}")
    return {"upstream": upstream, "scheme": u.scheme, "host": host, "port": port,
            "path": u.path or "/", "query": u.query, "fragment": u.fragment}


def upstream_key(upstream):
    u = urllib.parse.urlsplit(upstream)
    host = u.hostname or ""
    port = u.port or (443 if u.scheme == "https" else 80)
    return (u.scheme, "loopback" if host in LOOPBACK else host, port)


def hostname_for(name, domain):
    n = name.strip().lower().rstrip(".")
    if n in ("@", domain):
        return domain
    if n.endswith("." + domain):
        n = n[: -(len(domain) + 1)]
    if "." in n:
        die(f"'{name}' tem mais de um nível abaixo de {domain}",
            f"o certificado grátis (Universal SSL) só cobre *.{domain} — usar um label simples (ex.: --name app)", 2)
    if not LABEL_RE.match(n):
        die(f"label inválido '{name}'", "usar [a-z0-9-], 1–63 chars, sem hífen nas pontas (ex.: --name app3080)", 2)
    return f"{n}.{domain}"


def public_url(host, t, gate_token=None):
    q = t["query"]
    if gate_token:
        q = (q + "&" if q else "") + "key=" + gate_token
    return urllib.parse.urlunsplit(("https", host, t["path"] or "/", q, t["fragment"]))


def label_of(host, zone):
    return "@" if host == zone else host[: -(len(zone) + 1)]


def zdir(zone):
    return ZONES / zone


def boot_id():
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        pass
    try:  # macOS
        out = subprocess.run(["sysctl", "-n", "kern.boottime"], capture_output=True, text=True, timeout=3).stdout
        m = re.search(r"sec = (\d+)", out)
        if m:
            return "boot-" + m.group(1)
    except (OSError, subprocess.SubprocessError):
        pass
    return "unknown"


BOOT_ID = boot_id()


def load_zone(zone):
    return read_json(zdir(zone) / "zone.json")


def load_routes(zone):
    return read_json(zdir(zone) / "routes.json", {"version": 0, "routes": {}}) or {"version": 0, "routes": {}}


def save_routes(zone, doc):
    doc["version"] = int(doc.get("version", 0)) + 1
    write_json(zdir(zone) / "routes.json", doc)


def route_alive(r):
    return r.get("persist") or r.get("boot_id") in (None, "unknown", BOOT_ID)


def all_zones():
    return sorted(p.name for p in ZONES.iterdir() if (p / "zone.json").is_file()) if ZONES.is_dir() else []


class Lock:
    def __enter__(self):
        ROOT.mkdir(parents=True, exist_ok=True)
        self.f = open(ROOT / ".lock", "w")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


# -------------------------------------------------------------- processos ---
def pid_alive(pid, marker=None):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError):
        return False
    if marker:
        try:
            return marker in Path(f"/proc/{int(pid)}/cmdline").read_bytes().decode(errors="replace")
        except OSError:
            return True  # sem /proc (macOS): confiar no kill(0)
    return True


def systemctl(*args):
    return subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True)


def systemd_ok():
    return bool(shutil.which("systemctl")) and systemctl("show-environment").returncode == 0


def unit_name(zone):
    return f"cfx-zone@{zone}.service"


def read_runtime(zone):
    return read_json(zdir(zone) / "runtime.json")


def runner_pid(zone):
    rt = read_runtime(zone) or {}
    pid = rt.get("pid")
    return pid if pid_alive(pid, "zone-runner.mjs") else None


def ensure_unit_template(node):
    content = (
        "# Gerado por cloudflare-agent-skill/scripts/expose-port/domain.py — reescrito a cada up.\n"
        "[Unit]\n"
        "Description=cloudflare-agent-skill: shares da zona %i (named tunnel + router)\n"
        "After=network-online.target\nWants=network-online.target\n\n"
        "[Service]\nType=simple\n"
        f"ExecStart={node} {RUNNER} {ZONES}/%i\n"
        "Restart=always\nRestartSec=3\nStartLimitIntervalSec=0\n"
        f"StandardOutput=append:{ZONES}/%i/runner.log\nStandardError=inherit\n"
        "KillMode=control-group\nTimeoutStopSec=8\n\n"
        "[Install]\nWantedBy=default.target\n")
    UNIT_DIR.mkdir(parents=True, exist_ok=True)
    path = UNIT_DIR / UNIT_TEMPLATE
    if not path.exists() or path.read_text() != content:
        path.write_text(content)
        systemctl("daemon-reload")


def linger_state():
    if not shutil.which("loginctl"):
        return None
    r = subprocess.run(["loginctl", "show-user", os.environ.get("USER", ""), "-p", "Linger", "--value"],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def ensure_linger():
    """Sem linger o systemd --user pára no logout. Liga sozinho (polkit ou sudo -n); só avisa se não der."""
    if linger_state() in (None, "yes"):
        return True
    for cmd in (["loginctl", "enable-linger"], ["sudo", "-n", "loginctl", "enable-linger", os.environ.get("USER", "")]):
        if shutil.which(cmd[0]) and subprocess.run(cmd, capture_output=True).returncode == 0:
            return True
    warn("linger desligado: shares --persist param no logout — Solução: loginctl enable-linger $USER (pede senha)")
    return False


def rotate_log(zone):
    log = zdir(zone) / "runner.log"
    try:
        if log.stat().st_size > 5 * 1024 * 1024:
            log.write_text("")
    except OSError:
        pass
    return log


def log_tail(zone, n=12):
    try:
        lines = (zdir(zone) / "runner.log").read_text(errors="replace").splitlines()[-n:]
    except OSError:
        return ""
    return "\n".join("    " + ln[:220] for ln in lines)


def apply_runner(zone, doc, node):
    """Garante o zone-runner a servir `doc`: arranca se parado, senão SIGHUP (reload das rotas).
    A unit systemd fica enabled (arranca no boot) só se houver rota --persist."""
    any_persist = any(r.get("persist") for r in doc["routes"].values())
    use_systemd = systemd_ok()
    if any_persist and not use_systemd:
        die("--persist precisa de systemd --user (não disponível aqui)", "publicar sem --persist", 3)
    if use_systemd:
        ensure_unit_template(node)
        unit = unit_name(zone)
        enabled = systemctl("is-enabled", "--quiet", unit).returncode == 0
        if any_persist and not enabled:
            systemctl("enable", "--no-reload", unit)
            ensure_linger()
        elif not any_persist and enabled:
            systemctl("disable", "--no-reload", unit)
    pid = runner_pid(zone)
    if pid:
        os.kill(int(pid), signal.SIGHUP)
        return
    (zdir(zone) / "runtime.json").unlink(missing_ok=True)
    log = rotate_log(zone)
    if use_systemd:
        r = systemctl("restart", unit_name(zone))
        if r.returncode != 0:
            die(f"systemctl --user não arrancou {unit_name(zone)}: {r.stderr.strip()[:200]}",
                f"ver: journalctl --user -u {unit_name(zone)} -n 30")
    else:
        with open(log, "ab") as lf:
            subprocess.Popen([node, str(RUNNER), str(zdir(zone))], stdout=lf, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True, close_fds=True, cwd=str(zdir(zone)))


def stop_runner(zone):
    rt = read_runtime(zone) or {}
    if systemd_ok():
        unit = unit_name(zone)
        if systemctl("is-active", "--quiet", unit).returncode == 0:
            systemctl("stop", unit)
        if systemctl("is-enabled", "--quiet", unit).returncode == 0:
            systemctl("disable", "--no-reload", unit)  # sem daemon-reload: o boot lê os symlinks
    pid = rt.get("pid")
    if pid_alive(pid, "zone-runner.mjs"):
        try:
            os.kill(int(pid), signal.SIGTERM)
        except OSError:
            pass
        deadline = time.time() + 3.5
        while time.time() < deadline and pid_alive(pid, "zone-runner.mjs"):
            time.sleep(0.1)
        if pid_alive(pid, "zone-runner.mjs"):
            try:
                os.killpg(int(pid), signal.SIGKILL)
            except OSError:
                pass
    cpid = rt.get("cloudflared_pid")
    if pid_alive(cpid, "cloudflared"):
        try:
            os.kill(int(cpid), signal.SIGKILL)
        except OSError:
            pass
    (zdir(zone) / "runtime.json").unlink(missing_ok=True)


def wait_runner(zone, version, timeout=30):
    """Espera o runner ligado à edge E com a versão `version` das rotas carregada."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        rt = read_runtime(zone)
        if rt and rt.get("ready") and rt.get("routes_version", -1) >= version and pid_alive(rt.get("pid"), "zone-runner.mjs"):
            return rt
        time.sleep(0.05 if rt and rt.get("ready") else 0.2)
    rt = read_runtime(zone) or {}
    tail = log_tail(zone)
    die(f"o túnel da zona {zone} não ficou pronto em {int(time.time() - t0)} s"
        + (f" (último erro: {rt.get('last_error')})" if rt.get("last_error") else "")
        + (f"\n  log ({zdir(zone) / 'runner.log'}):\n{tail}" if tail else ""),
        "egress UDP/TCP 7844 bloqueado, credencial do túnel inválida ou túnel apagado fora daqui — "
        f"domain.py purge {zone} e repetir o up")


def local_alive(t):
    try:
        with socket.create_connection((t["host"], t["port"]), timeout=1.5):
            return True
    except OSError:
        return False


# ---------------------------------------------------------- DNS autoritativo ---
def _skip_name(data, off):
    while True:
        n = data[off]
        if n == 0:
            return off + 1
        if n & 0xC0 == 0xC0:
            return off + 2
        off += 1 + n


def auth_a(host, ns_ip, timeout=1.5):
    """A records de host perguntados DIRETO ao nameserver autoritativo (sem RD): não passa por
    resolvers recursivos, logo nunca semeia cache negativa (NXDOMAIN) em 1.1.1.1/8.8.8.8/ISP.
    None = sem resposta; [] = NXDOMAIN/sem A ainda."""
    qid = secrets.randbits(16)
    qname = b"".join(bytes([len(p)]) + p.encode() for p in host.rstrip(".").split(".")) + b"\0"
    pkt = struct.pack(">HHHHHH", qid, 0, 1, 0, 0, 0) + qname + struct.pack(">HH", 1, 1)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(pkt, (ns_ip, 53))
            data = s.recvfrom(4096)[0]
        rid, flags, qd, an, _, _ = struct.unpack(">HHHHHH", data[:12])
        if rid != qid:
            return None
        if flags & 0xF == 3:
            return []
        off = 12
        for _ in range(qd):
            off = _skip_name(data, off) + 4
        ips = []
        for _ in range(an):
            off = _skip_name(data, off)
            rtype, _, _, rdlen = struct.unpack(">HHIH", data[off:off + 10])
            off += 10
            if rtype == 1 and rdlen == 4:
                ips.append(socket.inet_ntoa(data[off:off + 4]))
            off += rdlen
        return ips
    except (OSError, struct.error, IndexError):
        return None


def auth_lookup(host, domain):
    if not ((read_json(ZONE_CACHE, {}) or {}).get(domain) or {}).get("name_servers"):
        try:
            zone_info(domain)
        except Fail:
            return None
    for ns in (read_json(ZONE_CACHE, {}) or {})[domain]["name_servers"]:
        try:
            ips = auth_a(host, socket.gethostbyname(ns))
        except OSError:
            continue
        if ips is not None:
            return ips
    return None


def edge_get(host, ip, path, timeout=8):
    """GET https://host/path ligado direto ao IP da edge (SNI = host): sem DNS, sem curl."""
    ctx = ssl.create_default_context()
    conn = None
    try:
        raw = socket.create_connection((ip, 443), timeout=timeout)
        conn = http.client.HTTPSConnection(host, 443, timeout=timeout, context=ctx)
        conn.sock = ctx.wrap_socket(raw, server_hostname=host)
        conn.request("GET", path, headers={"User-Agent": "cloudflare-agent-skill-probe", "Accept": "*/*"})
        r = conn.getresponse()
        return str(r.status), {k.lower(): v for k, v in r.getheaders()}
    except (OSError, ssl.SSLError, http.client.HTTPException):
        return "000", {}
    finally:
        if conn:
            conn.close()


def probe(host, domain, path, app_alive=True, budget=15):
    """Prova pela edge, sem DNS recursivo: (1) o autoritativo já responde pelo host; (2) a edge
    chega a ESTE router (/__cfx-health devolve x-cfx-proxy: ok — outro túnel/origem não);
    (3) a app responde no path pedido. Devolve HTTP status, 'app-down', 'dns-pendente' ou
    'edge-pendente'."""
    deadline, ips = time.time() + budget, []
    while not ips and time.time() < deadline:
        ips = auth_lookup(host, domain) or []
        if not ips:
            time.sleep(0.3)
    if not ips:
        return "dns-pendente"
    while True:
        _, head = edge_get(host, ips[0], "/__cfx-health")
        if head.get("x-cfx-proxy") == "ok":
            break
        if time.time() >= deadline:
            return "edge-pendente"
        time.sleep(0.4)
    if not app_alive:
        return "app-down"
    while True:
        code, head = edge_get(host, ips[0], path)
        if head.get("x-cfx-proxy") == "upstream-down":
            return "app-down"
        if code not in PROBE_FAIL or time.time() >= deadline:
            return code
        time.sleep(0.4)


# ----------------------------------------------------------------- túneis ---
def tunnel_create(name, creds, account_id):
    """Túnel local-managed pela API (token com Tunnel:Edit ou o do cert.pem) + ficheiro de credencial.
    Sem permissão e sem cert.pem → login no browser e nova tentativa."""
    for attempt in (1, 2):
        secret = base64.b64encode(secrets.token_bytes(32)).decode()
        try:
            for old in api("GET", f"/accounts/{account_id}/cfd_tunnel",
                           params={"name": name, "is_deleted": "false"}).get("result") or []:
                tunnel_delete(old["id"], account_id)  # sobra sem credencial local
            tid = api("POST", f"/accounts/{account_id}/cfd_tunnel",
                      {"name": name, "tunnel_secret": secret, "config_src": "local"})["result"]["id"]
            break
        except Fail as e:
            if e.kind == "auth" and attempt == 1 and not cert_file().is_file():
                login_flow()
                continue
            raise
    creds.unlink(missing_ok=True)
    fd = os.open(creds, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
    with os.fdopen(fd, "w") as f:
        json.dump({"AccountTag": account_id, "TunnelSecret": secret, "TunnelID": tid}, f)
    return tid


def tunnel_delete(tid, account_id):
    try:
        api("DELETE", f"/accounts/{account_id}/cfd_tunnel/{tid}/connections")
        api("DELETE", f"/accounts/{account_id}/cfd_tunnel/{tid}")
        return True
    except Fail as e:
        if "1003" in e.erro or "not found" in e.erro.lower():
            return True
        warn(f"túnel {tid} não apagado ({e.erro}) — apagar à mão: cloudflared tunnel delete -f {tid}")
        return False


# -------------------------------------------------------------------- DNS ---
def dns_records(zid, host):
    recs = api("GET", f"/zones/{zid}/dns_records", params={"name": host, "per_page": 100}).get("result") or []
    return [r for r in recs if r["type"] in ("A", "AAAA", "CNAME")]


def is_ours(rec):
    """Registo criado por ESTA máquina (outra máquina com a skill na mesma zona conta como terceiro)."""
    return (rec.get("comment") or "").startswith(f"cfx:{MACHINE}:")


def dns_upsert(zid, name, target, recs):
    """CNAME name → target (proxied). Um CNAME existente é PATCHado (troca atómica, sem janela
    NXDOMAIN); A/AAAA são apagados antes. Devolve o id do registo."""
    body = {"type": "CNAME", "name": name, "content": target, "proxied": True, "ttl": 1, "comment": DNS_COMMENT}
    mine = [r for r in recs if r["content"] == target]
    if mine:
        if not mine[0].get("proxied") or not is_ours(mine[0]):
            api("PATCH", f"/zones/{zid}/dns_records/{mine[0]['id']}", {"proxied": True, "comment": DNS_COMMENT})
        return mine[0]["id"]
    cnames = [r for r in recs if r["type"] == "CNAME"]
    if len(recs) == 1 and cnames:
        return api("PATCH", f"/zones/{zid}/dns_records/{cnames[0]['id']}", body)["result"]["id"]
    for r in recs:
        api("DELETE", f"/zones/{zid}/dns_records/{r['id']}")
    return api("POST", f"/zones/{zid}/dns_records", body)["result"]["id"]


def ensure_host_dns(z, host, force):
    """None = servido pelo curinga *.zona (nada a criar, instantâneo); senão o id do CNAME próprio."""
    zid, target = z["zone_id"], f"{z['tunnel_id']}.cfargotunnel.com"
    recs = dns_records(zid, host)
    foreign = [r for r in recs if r["content"] != target and not is_ours(r)]
    if foreign and not force:
        desc = ", ".join(f"{r['type']} → {r['content']}" for r in foreign)
        die(f"{host} já tem registo DNS que não é desta skill ({desc})",
            "outro --name, ou repetir com --force para assumir o nome (o registo antigo é substituído)")
    covered = bool(z.get("wildcard_id")) and host != z["zone"] and host.count(".") == z["zone"].count(".") + 1
    if not recs and covered:
        return None
    return dns_upsert(zid, host, target, recs)


def dns_delete(zid, rec_id, target):
    try:
        cur = api("GET", f"/zones/{zid}/dns_records/{rec_id}")["result"]
    except Fail:
        return "já não existia"
    if cur.get("content") != target:
        return f"MANTIDO (aponta agora para {cur.get('content')})"
    api("DELETE", f"/zones/{zid}/dns_records/{rec_id}")
    return "apagado"


# ------------------------------------------------------------------- zona ---
def ensure_zone(domain, cf_bin):
    """Túnel cfx-<zona> + curinga *.<zona> — criados UMA vez por zona; depois é só ler zone.json."""
    z = load_zone(domain)
    if z and Path(z["credentials_file"]).is_file():
        zone_info(domain)  # fixa a credencial preferida (cache local, sem rede)
        if z.get("cloudflared") != cf_bin:
            z["cloudflared"] = cf_bin
            write_json(zdir(domain) / "zone.json", z)
        return z, False
    zid, acc = zone_info(domain)
    d = zdir(domain)
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    tname = f"cfx-{domain.replace('.', '-')}-{MACHINE}"
    creds = d / "creds.json"
    tid = tunnel_create(tname, creds, acc)
    target = f"{tid}.cfargotunnel.com"
    wildcard_id = None
    if os.environ.get("CLOUDFLARE_EXPOSE_WILDCARD", "1") != "0":
        wc = f"*.{domain}"
        recs = dns_records(zid, wc)
        if all(is_ours(r) for r in recs):
            wildcard_id = dns_upsert(zid, wc, target, recs)
        else:
            warn(f"{wc} já existe e não é desta skill ({recs[0]['type']} → {recs[0]['content']}): cada host novo "
                 "recebe CNAME próprio (8–33 s de propagação na 1ª vez)")
    z = {"version": 2, "zone": domain, "zone_id": zid, "account_id": acc, "tunnel_id": tid, "tunnel_name": tname,
         "credentials_file": str(creds), "wildcard_id": wildcard_id, "cloudflared": cf_bin,
         "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    write_json(d / "zone.json", z)
    doc = load_routes(domain)  # túnel recriado (credencial perdida): CNAMEs próprios passam para o novo
    for h, r in doc["routes"].items():
        if r.get("dns_record_id"):
            r["dns_record_id"] = dns_upsert(zid, h, target, dns_records(zid, h))
    if doc["routes"]:
        save_routes(domain, doc)
    return z, True


def prune_stale(z, doc):
    """Rotas efémeras de um boot anterior: fora da tabela e sem CNAME próprio."""
    stale = [h for h, r in doc["routes"].items() if not route_alive(r)]
    for h in stale:
        rid = doc["routes"].pop(h).get("dns_record_id")
        if rid:
            try:
                dns_delete(z["zone_id"], rid, f"{z['tunnel_id']}.cfargotunnel.com")
            except Fail:
                pass
    return stale


# ---------------------------------------------------------------- comandos ---
def render_qr(text):
    if shutil.which("qrencode"):
        subprocess.run(["qrencode", "-t", "ANSIUTF8", "-o", "-", text])
        return
    try:
        import segno  # type: ignore
        segno.make(text).terminal()
    except ImportError:
        say("  (QR indisponível: instalar qrencode ou pip install --user segno)")


def prepare(login_timeout):
    """Tudo o que o up precisa, sem perguntar: ferramentas e credencial."""
    cf_bin, node = ensure_cloudflared(), ensure_node()
    if not cred_candidates():
        login_flow(login_timeout)
    return cf_bin, node


def cmd_up(a):
    t = parse_target(a.url)
    cf_bin, node = prepare(a.login_timeout)
    domain = resolve_domain(a.domain, a.name)
    t0 = time.time()
    alive = local_alive(t)
    if not alive:
        warn(f"nada responde em {t['upstream']} agora — publico na mesma; a URL funciona quando a app subir")
    with Lock():
        z, zone_new = ensure_zone(domain, cf_bin)
        doc = load_routes(domain)
        routes = doc["routes"]
        prune_stale(z, doc)
        if a.name:
            host = hostname_for(a.name, domain)
        else:
            same = [h for h, r in routes.items() if not r.get("alias_of")
                    and upstream_key(r["upstream"]) == upstream_key(t["upstream"])]
            host = same[0] if same else hostname_for(str(t["port"]), domain)
        if routes.get(host, {}).get("alias_of"):
            host = routes[host]["alias_of"]
        aliases = [h for h in (hostname_for(x, domain) for x in (a.alias or [])) if h != host]
        prev = dict(routes.get(host) or {})
        keep_host = a.keep_host if a.keep_host is not None else bool(prev.get("keep_host"))
        gate = a.gate if a.gate is not None else bool(prev.get("gate"))
        persist = a.persist if a.persist is not None else bool(prev.get("persist"))
        gate_token = (prev.get("gate_token") or secrets.token_urlsafe(32)) if gate else None
        group = list(dict.fromkeys([host, *[h for h, r in routes.items() if r.get("alias_of") == host], *aliases]))
        new_dns = []
        for h in group:
            if h in routes and routes[h].get("dns_ok"):
                dns_id = routes[h].get("dns_record_id")
            else:
                dns_id = ensure_host_dns(z, h, a.force)
                new_dns.append(h)
            routes[h] = {"upstream": t["upstream"], "keep_host": keep_host, "gate": gate, "gate_token": gate_token,
                         "persist": persist, "boot_id": BOOT_ID, "alias_of": None if h == host else host,
                         "dns_record_id": dns_id, "dns_ok": True,
                         "created_at": (routes.get(h) or {}).get("created_at") or time.strftime("%Y-%m-%dT%H:%M:%S%z")}
        changed = bool(new_dns) or {k: v for k, v in prev.items() if k != "boot_id"} != \
            {k: v for k, v in routes[host].items() if k != "boot_id"}
        save_routes(domain, doc)
        try:
            apply_runner(domain, doc, node)
            rt = wait_runner(domain, doc["version"])
        except (Fail, KeyboardInterrupt):
            if not prev:  # não deixar meio-publicado
                for h in group:
                    r = routes.pop(h, None) or {}
                    if r.get("dns_record_id") and h in new_dns:
                        dns_delete(z["zone_id"], r["dns_record_id"], f"{z['tunnel_id']}.cfargotunnel.com")
                save_routes(domain, doc)
            raise
    explicit_new = any(routes[h].get("dns_record_id") for h in new_dns)
    code = probe(host, domain, t["path"], alive, budget=45 if (explicit_new or zone_new) else 15)
    url = public_url(host, t, gate_token)
    secs = round(time.time() - t0, 1)
    als = [h for h, r in routes.items() if r.get("alias_of") == host]
    down_cmd = f"python3 {SELF} down {host}"
    if JSON_OUT:
        print(json.dumps({"ok": True, "url": url, "host": host, "aliases": als, "upstream": t["upstream"],
                          "persist": persist, "gate": gate, "keep_host": keep_host, "probe": code, "seconds": secs,
                          "dns": {h: ("curinga" if not routes[h]["dns_record_id"] else "cname") for h in [host, *als]},
                          "tunnel": z["tunnel_name"], "down": down_cmd}, ensure_ascii=False))
        return 0
    verb = "publicado" if not prev else ("atualizado" if changed else "já estava no ar")
    edge = {"app-down": "túnel OK; a app local não responde — a URL funciona assim que ela subir",
            "dns-pendente": "DNS ainda a propagar no autoritativo — a URL funciona em segundos",
            "edge-pendente": "a edge ainda não chega ao túnel (propagação da 1ª vez) — repetir o up em segundos"}.get(
        code, "a app respondeu" if code not in PROBE_FAIL else "a edge ainda não responde — repetir em segundos")
    say(f"OK: {verb} em {secs} s")
    say(f"  URL pública   {url}")
    say(f"  host          {host}" + (f"  (+ {', '.join(als)})" if als else "")
        + f"  [DNS: {'curinga *.' + domain if not routes[host]['dns_record_id'] else 'CNAME próprio'}]")
    say(f"  upstream      {t['upstream']}  ({'Host original' if keep_host else 'Host/Origin reescritos para o upstream'})")
    say(f"  túnel         {z['tunnel_name']} ({z['tunnel_id'][:8]}…) · {len(rt.get('connections', []))} conexões"
        + (f" ({', '.join(rt.get('locations', []))})" if rt.get("locations") else ""))
    say("  modo          " + ("persistente — volta sozinho após reboot/crash (systemd --user)" if persist
                             else "efémero — cai no reboot (--persist para ficar)"))
    if gate:
        say("  senha         ?key= na URL (gate ligado: sem key/cookie → 401)")
    say(f"  verificação   HTTPS {code} pela edge ({edge})")
    say(f"  derrubar      {down_cmd}")
    if a.qr or sys.stdout.isatty():
        render_qr(url)
    say(f"URL={url}")
    return 0


def select_routes(targets, zone, routes):
    """Hosts a remover: alvo = host, label, '@', porta do upstream ou 'all'. Um host primário leva os aliases."""
    picked = []
    for target in targets:
        t = target.strip().lower().rstrip(".")
        for h, r in routes.items():
            port = str(urllib.parse.urlsplit(r["upstream"]).port or "")
            if t in ("all", h, label_of(h, zone)) or (t == port and not r.get("alias_of")):
                picked.append(h)
    out = []
    for h in picked:
        for x in [h, *[a for a, r in routes.items() if r.get("alias_of") == h]]:
            if x not in out:
                out.append(x)
    return out


def cmd_down(a):
    t0 = time.time()
    done, offline = [], {}
    with Lock():
        for zone in all_zones():
            z = load_zone(zone)
            doc = load_routes(zone)
            gone = select_routes(a.targets, zone, doc["routes"])
            if not gone:
                continue
            zone_info(zone)
            prune_stale(z, doc)
            gone = [h for h in gone if h in doc["routes"]]
            removed = {h: doc["routes"].pop(h) for h in gone}
            save_routes(zone, doc)
            pid = runner_pid(zone)
            if pid:  # 1º tirar as rotas do router (404 em ~50 ms); processo e DNS depois
                os.kill(int(pid), signal.SIGHUP)
                try:
                    wait_runner(zone, doc["version"], timeout=3)
                except Fail:
                    pass
            if doc["routes"]:
                apply_runner(zone, doc, find_tool("node") or str(PRIVATE_BIN / "node"))
            else:
                stop_runner(zone)
            target = f"{z['tunnel_id']}.cfargotunnel.com"
            with ThreadPoolExecutor(max_workers=4) as ex:
                dns = dict(zip(removed, ex.map(
                    lambda r: dns_delete(z["zone_id"], r["dns_record_id"], target) if r.get("dns_record_id") else "curinga",
                    removed.values())))
            ips = auth_lookup(next(iter(removed)), zone) or auth_lookup(f"cfx-probe.{zone}", zone) or [] if removed else []
            for h in removed:
                done.append({"host": h, "zone": zone, "dns": dns[h]})
                if ips:
                    offline[h] = edge_get(h, ips[0], "/")[0]
    if not done:
        if a.targets == ["all"]:
            say("nada publicado por domain.py nesta máquina")
            if JSON_OUT:
                print(json.dumps({"ok": True, "down": []}))
            return 0
        die(f"nenhum share corresponde a {' '.join(a.targets)}", f"ver: python3 {SELF} list")
    secs = round(time.time() - t0, 1)
    if JSON_OUT:
        print(json.dumps({"ok": True, "down": done, "edge_now": offline, "seconds": secs}, ensure_ascii=False))
        return 0
    for d in done:
        code = offline.get(d["host"])
        say(f"DOWN: {d['host']} — DNS {d['dns']}" + (f" · edge agora: HTTP {code}" if code else ""))
    say(f"OK: {len(done)} host(s) derrubado(s) em {secs} s")
    return 0


def cmd_purge(a):
    zones = all_zones() if a.zone == "all" else [a.zone.strip().lower().rstrip(".")]
    out = []
    with Lock():
        for zone in zones:
            z = load_zone(zone)
            if not z:
                continue
            zone_info(zone)
            stop_runner(zone)
            doc = load_routes(zone)
            target = f"{z['tunnel_id']}.cfargotunnel.com"
            ids = [r["dns_record_id"] for r in doc["routes"].values() if r.get("dns_record_id")]
            if z.get("wildcard_id"):
                ids.append(z["wildcard_id"])
            with ThreadPoolExecutor(max_workers=6) as ex:
                dns = list(ex.map(lambda i: dns_delete(z["zone_id"], i, target), ids))
            tun_ok = tunnel_delete(z["tunnel_id"], z["account_id"])
            shutil.rmtree(zdir(zone), ignore_errors=True)
            out.append({"zone": zone, "routes": list(doc["routes"]), "dns": dns, "tunnel": "apagado" if tun_ok else "NÃO apagado"})
            say(f"PURGE: {zone} — {len(doc['routes'])} rota(s), {len(ids)} registo(s) DNS ({', '.join(dns) or '—'}), "
                f"túnel {z['tunnel_name']} {'apagado' if tun_ok else 'NÃO apagado'}")
    if JSON_OUT:
        print(json.dumps({"ok": True, "purged": out}, ensure_ascii=False))
    elif not out:
        say("nada a limpar")
    return 0


def untracked_cloudflared():
    ours = set()
    for zone in all_zones():
        pid = (read_runtime(zone) or {}).get("cloudflared_pid")
        if pid:
            ours.add(int(pid))
    out = []
    r = subprocess.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and os.path.basename(parts[1].split()[0]) == "cloudflared" and int(parts[0]) not in ours \
                and " tunnel login" not in parts[1]:
            out.append({"pid": int(parts[0]), "args": parts[1][:200]})
    return out


def cmd_list(a):
    zones = []
    for zone in all_zones():
        z = load_zone(zone)
        rt = read_runtime(zone) or {}
        running = bool(runner_pid(zone))
        doc = load_routes(zone)
        rows = []
        for h, r in sorted(doc["routes"].items(), key=lambda kv: (kv[1].get("alias_of") or kv[0], kv[0])):
            rows.append({"host": h, "alias_of": r.get("alias_of"), "upstream": r["upstream"], "persist": bool(r.get("persist")),
                         "gate": bool(r.get("gate")), "dns": "cname" if r.get("dns_record_id") else "curinga",
                         "stale": not route_alive(r), "live": running and h in rt.get("routes", [])})
        zones.append({"zone": zone, "tunnel": z["tunnel_name"], "wildcard": bool(z.get("wildcard_id")), "running": running,
                      "connections": len(rt.get("connections", [])) if running else 0, "routes": rows})
    others = untracked_cloudflared()
    if JSON_OUT:
        print(json.dumps({"zones": zones, "untracked_cloudflared": others}, ensure_ascii=False))
        return 0
    if not any(z["routes"] for z in zones):
        say("nenhum share publicado por domain.py")
    for z in zones:
        say(f"zona {z['zone']} · túnel {z['tunnel']} · {'curinga *.' + z['zone'] if z['wildcard'] else 'sem curinga'} · "
            + (f"router no ar ({z['connections']} conexões)" if z["running"] else "router parado"))
        for r in z["routes"]:
            state = "no ar" if r["live"] else ("expirada (reboot)" if r["stale"] else "parada")
            name = ("  ↳ " if r["alias_of"] else "  ") + r["host"]
            say(f"{name:<30} {r['upstream']:<26} {'persistente' if r['persist'] else 'efémero':<12} "
                f"{'gate ' if r['gate'] else ''}{r['dns']:<8} {state}")
    if others:
        say("\ncloudflared NÃO gerido por domain.py (quick tunnels, setups antigos…):")
        for o in others:
            say(f"  pid {o['pid']}: {o['args']}")
    return 0


def cmd_setup(a):
    """Verifica e prepara TUDO sem perguntar. --check = só relatório (nada instala/muda);
    --deps = só ferramentas (usado pelo quick tunnel)."""
    rows, problems = [], []

    def row(item, state, detail):
        rows.append({"item": item, "estado": state, "detalhe": detail})
        if state in ("FALTA", "ERRO", "SEM PERMISSÃO"):
            problems.append(f"{item}: {detail}")

    rows.append({"item": "python3", "estado": "ok", "detalhe": platform.python_version()})
    for name, finder, installer in (("cloudflared", lambda: find_tool("cloudflared"), install_cloudflared),
                                    ("node", lambda: next((p for p in (find_tool("node"), str(PRIVATE_BIN / "node"))
                                                           if p and Path(p).exists()
                                                           and (node_version(p) or (0, 0)) >= NODE_MIN), None),
                                     install_node)):
        p = finder()
        if p:
            v = subprocess.run([p, "--version"], capture_output=True, text=True).stdout.strip().splitlines()
            row(name, "ok", f"{(v or ['?'])[0]} ({p})")
        elif a.check:
            row(name, "FALTA", f"python3 {SELF} setup instala sozinho")
        else:
            try:
                row(name, "INSTALADO", installer())
            except Fail as e:
                row(name, "ERRO", f"{e.erro} — {e.solucao}")
    if not a.deps:
        cands = cred_candidates()
        if not cands and not a.check:
            try:
                login_flow(a.login_timeout)
            except Fail as e:
                if e.code == 4:
                    raise
                row("credencial", "ERRO", f"{e.erro} — {e.solucao}")
            cands = cred_candidates()
        cert = cert_info()
        row("credencial", "ok" if cands else "FALTA",
            " + ".join(label for label, _ in cands) if cands else f"python3 {SELF} setup (login no browser)")
        domain = None
        if cands:
            try:
                domain = resolve_domain(a.domain, remember=not a.check)
                zid, acc = zone_info(domain)
                row("domínio", "ok", f"{domain} (credencial: {PREFERRED_CRED})"
                    + ("" if os.environ.get("CLOUDFLARE_EXPOSE_DOMAIN") != domain or a.domain else " · padrão em config.env"))
                api("GET", f"/zones/{zid}/dns_records", params={"per_page": 1})
                if a.check:
                    row("DNS", "ok", "leitura ok (escrita testada no setup sem --check)")
                else:  # prova real e reversível
                    rid = api("POST", f"/zones/{zid}/dns_records", {"type": "TXT", "name": "_cfx-setup-probe",
                                                                   "content": '"cloudflare-agent-skill setup"',
                                                                   "ttl": 60, "comment": DNS_COMMENT})["result"]["id"]
                    api("DELETE", f"/zones/{zid}/dns_records/{rid}")
                    row("DNS", "ok", f"leitura + escrita na zona {domain}")
                z = load_zone(domain)
                if z and Path(z["credentials_file"]).is_file():
                    row("túnel", "ok", f"{z['tunnel_name']} já existe (credencial local)")
                elif a.check:
                    row("túnel", "ok" if cert and cert.get("accountID") == acc else "?",
                        "cert.pem da conta cobre criar túneis" if cert else "depende de Tunnel:Edit no token")
                else:
                    name = f"cfx-setup-probe-{secrets.token_hex(3)}"
                    tmp_creds = DATA_DIR / (name + ".json")
                    DATA_DIR.mkdir(parents=True, exist_ok=True)
                    tid = tunnel_create(name, tmp_creds, acc)
                    tunnel_delete(tid, acc)
                    tmp_creds.unlink(missing_ok=True)
                    row("túnel", "ok", "criar/apagar túneis na conta")
            except Fail as e:
                if e.code == 4:
                    raise
                row("domínio/permissões", "SEM PERMISSÃO" if e.kind == "auth" else "ERRO", f"{e.erro} — {e.solucao}")
        if systemd_ok():
            lg = linger_state()
            if lg != "yes" and not a.check:
                lg = "yes" if ensure_linger() else lg
            row("persistência", "ok" if lg == "yes" else "parcial",
                "systemd --user + linger" if lg == "yes" else "systemd --user sem linger (--persist pára no logout)")
        else:
            row("persistência", "parcial", "sem systemd --user: shares efémeros funcionam; --persist indisponível")
    if JSON_OUT:
        print(json.dumps({"ok": not problems, "checks": rows, "problems": problems}, ensure_ascii=False))
    else:
        for r in rows:
            say(f"  {r['item']:<20} {r['estado']:<14} {r['detalhe']}")
        say(("OK: pronto — " + (f"python3 {SELF} up '<url local>'" if not a.deps else "ferramentas instaladas"))
            if not problems else f"Erro: {len(problems)} pendência(s) acima — Solução: ver a coluna detalhe")
    return 0 if not problems else 3


def cmd_selftest(_a):
    t = parse_target("http://127.0.0.1:3080/?token=abc#x")
    assert t["upstream"] == "http://127.0.0.1:3080" and t["path"] == "/" and t["query"] == "token=abc", t
    assert public_url("example.com", t) == "https://example.com/?token=abc#x"
    assert public_url("a.example.com", t, "K" * 20) == "https://a.example.com/?token=abc&key=" + "K" * 20 + "#x"
    assert parse_target("8080")["upstream"] == "http://127.0.0.1:8080"
    assert parse_target("localhost:5173/app")["path"] == "/app"
    assert parse_target("https://127.0.0.1:443/")["upstream"] == "https://127.0.0.1"
    assert parse_target("http://[::1]:3000")["upstream"] == "http://[::1]:3000"
    assert parse_target("0.0.0.0:9000")["host"] == "127.0.0.1"
    assert upstream_key("http://localhost:3080") == upstream_key("http://127.0.0.1:3080")
    assert upstream_key("http://127.0.0.1:3080") != upstream_key("https://127.0.0.1:3080")
    assert hostname_for("@", "example.com") == "example.com"
    assert hostname_for("3080", "example.com") == "3080.example.com"
    assert hostname_for("App.example.com", "example.com") == "app.example.com"
    assert label_of("example.com", "example.com") == "@" and label_of("www.example.com", "example.com") == "www"
    for bad in ("a.b", "-x", "x" * 64):
        try:
            hostname_for(bad, "example.com")
            raise AssertionError(bad)
        except Fail:
            pass
    routes = {"example.com": {"upstream": "http://127.0.0.1:3080"},
              "www.example.com": {"upstream": "http://127.0.0.1:3080", "alias_of": "example.com"},
              "5173.example.com": {"upstream": "http://localhost:5173"}}
    assert select_routes(["@"], "example.com", routes) == ["example.com", "www.example.com"]
    assert select_routes(["example.com"], "example.com", routes) == ["example.com", "www.example.com"]
    assert select_routes(["3080"], "example.com", routes) == ["example.com", "www.example.com"]
    assert select_routes(["www"], "example.com", routes) == ["www.example.com"]
    assert select_routes(["5173.example.com"], "example.com", routes) == ["5173.example.com"]
    assert sorted(select_routes(["all"], "example.com", routes)) == sorted(routes)
    assert route_alive({"persist": False, "boot_id": BOOT_ID}) and route_alive({"persist": True, "boot_id": "old"})
    assert BOOT_ID == "unknown" or not route_alive({"persist": False, "boot_id": "old-boot"})
    print("selftest OK — domain.py offline (parsing, hostnames, URL pública, seleção de rotas, boot)")
    return 0


def main(argv=None):
    global JSON_OUT
    p = argparse.ArgumentParser(prog="domain.py", description=__doc__.split("\n")[0],
                                epilog=__doc__.split("\n", 2)[2], formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    up = sub.add_parser("up", help="publica <url> em https://<host>.<domínio> (preserva path/query)")
    up.add_argument("url")
    up.add_argument("--domain", help="zona Cloudflare (ex.: example.com)")
    up.add_argument("--name", help="label (app), '@' para o apex, ou FQDN da zona; omissão: rota existente ou <porta>")
    up.add_argument("--alias", action="append", help="hostname extra na mesma rota (repetível), ex.: --alias www")
    up.add_argument("--persist", action=argparse.BooleanOptionalAction, default=None,
                    help="sobrevive a reboot/crash (systemd --user); omissão: efémero ou o que a rota já tinha")
    up.add_argument("--keep-host", action=argparse.BooleanOptionalAction, default=None,
                    help="não reescrever Host/Origin (apps que precisam do host público)")
    up.add_argument("--gate", action=argparse.BooleanOptionalAction, default=None,
                    help="senha ?key= à frente da app (para apps SEM auth própria)")
    up.add_argument("--force", action="store_true", help="assumir um nome que já tem registo DNS de terceiros")
    up.add_argument("--qr", action="store_true", help="imprimir QR code da URL")
    up.add_argument("--login-timeout", type=int, default=300, help="segundos à espera do Authorize no browser (1ª vez)")
    up.add_argument("--json", action="store_true")
    down = sub.add_parser("down", help="derruba rota(s): 404 imediato + CNAMEs próprios apagados")
    down.add_argument("targets", nargs="+", help="host, label, @, porta ou 'all'")
    down.add_argument("--json", action="store_true")
    ls = sub.add_parser("list", help="rotas publicadas e cloudflared não geridos")
    ls.add_argument("--json", action="store_true")
    st = sub.add_parser("setup", help="prepara a máquina sem perguntar: instala, faz login, testa permissões")
    st.add_argument("--check", action="store_true", help="só relatório: não instala nem altera nada")
    st.add_argument("--deps", action="store_true", help="só ferramentas (cloudflared + node)")
    st.add_argument("--domain", help="zona a preparar (fica como padrão em config.env)")
    st.add_argument("--login-timeout", type=int, default=300)
    st.add_argument("--json", action="store_true")
    pg = sub.add_parser("purge", help="remove tudo desta skill na zona: rotas, CNAMEs, curinga e túnel")
    pg.add_argument("zone", help="zona (ex.: example.com) ou 'all'")
    pg.add_argument("--json", action="store_true")
    sub.add_parser("selftest", help="testes offline")
    a = p.parse_args(argv)
    JSON_OUT = bool(getattr(a, "json", False))
    if a.cmd == "selftest":
        return cmd_selftest(a)
    load_env()
    try:
        return {"up": cmd_up, "down": cmd_down, "list": cmd_list, "purge": cmd_purge, "setup": cmd_setup}[a.cmd](a)
    except Fail as e:
        if JSON_OUT:
            print(json.dumps({"ok": False, "erro": e.erro, "solucao": e.solucao}, ensure_ascii=False))
        else:
            print(f"Erro: {e.erro} — Solução: {e.solucao}", file=sys.stderr)
        return e.code
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
