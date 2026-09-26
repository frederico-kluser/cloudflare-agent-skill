#!/usr/bin/env node
/**
 * zone-runner.mjs — runtime of ALL shares of one Cloudflare zone (one named tunnel per zone).
 * Started/stopped/reloaded by domain.py — never by hand.
 *
 * Why one tunnel per zone: `*.<zone>` points at this tunnel once, so a new share is only a
 * route in the table below — no DNS record to propagate (Cloudflare takes 8–33 s to route a
 * brand-new hostname; a wildcard-covered one answers in ~0.06 s). Down = route removed = 404
 * at once.
 *
 *   1. Router on 127.0.0.1:<random free port>, zero dependencies. Host header → route
 *      (routes.json). Per route:
 *      - Host → the loopback upstream, Origin/Referer too when they are the route's own
 *        public origin (a foreign Origin passes untouched, so CSRF/origin checks still see
 *        it). Fences like Vite's allowedHosts or loopback-only /api pass without touching the
 *        project. keep_host disables it.
 *      - Absolute redirects to the upstream come back as the public origin.
 *      - Path, query (?token=…), body, other headers and WebSocket upgrades pass verbatim.
 *      - Optional ?key= password gate (gate=true, same model as proxy.mjs).
 *      Unknown host → 404. /__cfx-health → 200 (domain.py probes the edge with it).
 *   2. `cloudflared tunnel run` with a catch-all ingress to the router — never restarted when
 *      routes change. Restarted with backoff if it dies.
 *
 * Usage:   node zone-runner.mjs <zone-dir>     (zone.json + routes.json inside)
 * Reload:  SIGHUP (domain.py sends it and waits for runtime.json → routes_version), plus a
 *          500 ms routes.json watch as fallback.
 * Runtime: <zone-dir>/runtime.json (pid, proxy port, connections, ready, routes_version).
 * Stop:    SIGTERM/SIGINT → cloudflared gets a double SIGTERM (skips its grace period).
 * Never logs query strings (they carry tokens).
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const zoneDir = process.argv[2]
if (!zoneDir) {
  console.error('usage: zone-runner.mjs <zone-dir>')
  process.exit(2)
}
const zone = JSON.parse(fs.readFileSync(path.join(zoneDir, 'zone.json'), 'utf8'))
const routesPath = path.join(zoneDir, 'routes.json')
const runtimePath = path.join(zoneDir, 'runtime.json')
const cfConfigPath = path.join(zoneDir, 'cloudflared.yml')
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
const KEY_PARAM = 'key'
const COOKIE_NAME = '__cfx_sid'
const HEALTH_PATH = '/__cfx-health'

const log = (msg) => console.log(`${new Date().toISOString()} [runner] ${msg}`)
const pathOnly = (url) => {
  try { return new URL(url, 'http://x').pathname } catch { return '?' }
}
// Same derivation as domain.py boot_id(): Linux boot_id, macOS kern.boottime, else unknown.
const bootId = (() => {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { /* not Linux */ }
  try {
    const sec = /sec = (\d+)/.exec(execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }))?.[1]
    if (sec) return `boot-${sec}`
  } catch { /* no sysctl */ }
  return 'unknown'
})()

// ---------------------------------------------------------------- runtime ---
const runtime = {
  pid: process.pid,
  zone: zone.zone,
  proxy_port: null,
  cloudflared_pid: null,
  connections: [],
  locations: [],
  ready: false,
  routes_version: -1,
  routes: [],
  restarts: 0,
  last_error: null,
  started_at: new Date().toISOString(),
}
const liveConns = new Map() // connIndex -> location

function writeRuntime() {
  runtime.connections = [...liveConns.keys()].sort()
  runtime.locations = [...new Set(liveConns.values())].filter(Boolean)
  runtime.ready = liveConns.size > 0
  const tmp = `${runtimePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(runtime, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, runtimePath)
}

// ----------------------------------------------------------------- routes ---
let routes = new Map() // host -> compiled route

function compileRoute(host, r, previous) {
  const up = new URL(r.upstream)
  const proto = up.protocol === 'https:' ? 'https' : 'http'
  const route = {
    host,
    upstream: r.upstream,
    proto,
    transport: proto === 'https' ? https : http,
    connectHost: up.hostname.replace(/^\[|\]$/g, ''),
    port: Number(up.port || (proto === 'https' ? 443 : 80)),
    authority: up.host,
    origin: `${proto}://${up.host}`,
    publicOrigin: `https://${host}`,
    keepHost: Boolean(r.keep_host),
    gate: Boolean(r.gate) && String(r.gate_token ?? '').length >= 16,
    gateToken: Buffer.from(String(r.gate_token ?? '')),
    sessions: new Set(),
  }
  // keep live gate sessions across reloads when the password did not change
  if (previous && previous.gate && route.gate && previous.gateToken.equals(route.gateToken)) {
    route.sessions = previous.sessions
  }
  return route
}

function loadRoutes(reason) {
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log(`routes.json unreadable (${err.message}) — keeping ${routes.size} route(s)`)
      return
    }
    doc = { version: 0, routes: {} }
  }
  const next = new Map()
  for (const [host, r] of Object.entries(doc.routes ?? {})) {
    // ephemeral routes die with the boot they were created in
    if (!r.persist && r.boot_id && bootId !== 'unknown' && r.boot_id !== bootId) continue
    try {
      next.set(host.toLowerCase(), compileRoute(host.toLowerCase(), r, routes.get(host.toLowerCase())))
    } catch (err) {
      log(`route ${host} ignored: ${err.message}`)
    }
  }
  routes = next
  runtime.routes_version = doc.version ?? 0
  runtime.routes = [...routes.keys()].sort()
  writeRuntime()
  log(`routes v${runtime.routes_version} loaded (${reason}): ${runtime.routes.join(', ') || '—'}`)
}

// ------------------------------------------------------------------ proxy ---
function isUpstreamUrl(route, u) {
  if (u.host === route.authority) return true
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  return port === route.port && LOOPBACK_NAMES.has(u.hostname.replace(/^\[|\]$/g, ''))
}

function requestHeaders(route, req) {
  const h = { ...req.headers }
  if (route.keepHost) return h
  h.host = route.authority
  if (typeof h.origin === 'string' && h.origin.toLowerCase() === route.publicOrigin) h.origin = route.origin
  if (typeof h.referer === 'string') {
    const ref = h.referer.toLowerCase()
    if (ref === route.publicOrigin || ref.startsWith(route.publicOrigin + '/')) {
      h.referer = route.origin + h.referer.slice(route.publicOrigin.length)
    }
  }
  return h
}

function responseHeaders(route, headers) {
  const out = { ...headers }
  if (!route.keepHost && typeof out.location === 'string') {
    try {
      const u = new URL(out.location)
      if (isUpstreamUrl(route, u)) out.location = route.publicOrigin + u.pathname + u.search + u.hash
    } catch { /* relative Location — already right */ }
  }
  if (route.gate) out['referrer-policy'] = 'no-referrer'
  return out
}

function sessionIdFrom(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim()
  }
  return undefined
}

function keyMatches(route, candidate) {
  if (typeof candidate !== 'string') return false
  const c = Buffer.from(candidate)
  return c.length === route.gateToken.length && crypto.timingSafeEqual(c, route.gateToken)
}

/** Password gate: true when the request may reach the upstream. */
function gate(route, req, res) {
  if (!route.gate || route.sessions.has(sessionIdFrom(req))) return true
  const u = new URL(req.url, 'http://x')
  if (keyMatches(route, u.searchParams.get(KEY_PARAM))) {
    const sid = crypto.randomBytes(24).toString('base64url')
    route.sessions.add(sid)
    u.searchParams.delete(KEY_PARAM)
    log(`${route.host}: key accepted, session minted (${req.method} ${u.pathname})`)
    res.writeHead(302, {
      location: u.pathname + u.search,
      'set-cookie': `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=31536000`,
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    })
    res.end()
    return false
  }
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end('<!doctype html><meta charset="utf-8"><title>401</title><h1>401 Unauthorized</h1>'
    + '<p>Este link precisa da senha (?key=) impressa pelo domain.py.</p>')
  return false
}

function routeFor(req) {
  const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
  return routes.get(host)
}

function notFound(req, res) {
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><meta charset="utf-8"><title>404</title><h1>404</h1>'
    + `<p>Nada publicado em ${String(req.headers.host ?? '').replace(/[<>&"]/g, '')}.</p>`)
}

const server = http.createServer((req, res) => {
  if (req.url === HEALTH_PATH) {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'x-cfx-proxy': 'ok' })
    res.end('ok')
    return
  }
  const route = routeFor(req)
  if (!route) return notFound(req, res)
  if (!gate(route, req, res)) return
  const upReq = route.transport.request({
    host: route.connectHost,
    port: route.port,
    method: req.method,
    path: req.url,
    headers: requestHeaders(route, req),
    autoSelectFamily: true,
    rejectUnauthorized: false, // dev/self-signed upstream; public TLS ends at the Cloudflare edge
  }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, responseHeaders(route, upRes.headers))
    upRes.pipe(res)
  })
  upReq.on('error', (err) => {
    log(`${route.host}: upstream error on ${req.method} ${pathOnly(req.url)}: ${err.message}`)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'x-cfx-proxy': 'upstream-down' })
    res.end(`share proxy: upstream ${route.origin} unavailable (${err.code ?? err.message})\n`)
  })
  req.pipe(upReq)
})

// WebSocket (and any Upgrade): gate, then relay the handshake with the same header rewrite
// and splice the sockets — the upstream's 101 (or error) goes back verbatim.
server.on('upgrade', (req, socket, head) => {
  const route = routeFor(req)
  if (!route || (route.gate && !route.sessions.has(sessionIdFrom(req)))) {
    socket.end(`HTTP/1.1 ${route ? '401 Unauthorized' : '404 Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    return
  }
  const onConnect = () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
    for (const [name, value] of Object.entries(requestHeaders(route, req))) {
      for (const v of Array.isArray(value) ? value : [value]) raw += `${name}: ${v}\r\n`
    }
    up.write(raw + '\r\n')
    if (head?.length) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  }
  const up = route.proto === 'https'
    ? tls.connect({
      host: route.connectHost,
      port: route.port,
      servername: net.isIP(route.connectHost) ? undefined : route.connectHost,
      rejectUnauthorized: false,
    }, onConnect)
    : net.connect({ host: route.connectHost, port: route.port, autoSelectFamily: true }, onConnect)
  up.on('error', (err) => {
    log(`${route.host}: upgrade error on ${pathOnly(req.url)}: ${err.message}`)
    socket.destroy()
  })
  socket.on('error', () => up.destroy())
})

server.on('clientError', (_err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

// ------------------------------------------------------------ cloudflared ---
let cf = null
let stopping = false
let backoffMs = 1000

function writeCloudflaredConfig(port) {
  const lines = [
    '# generated by zone-runner.mjs (cloudflare-agent-skill) — rewritten on every start',
    `tunnel: ${zone.tunnel_id}`,
    `credentials-file: ${zone.credentials_file}`,
    'no-autoupdate: true',
    'ingress:',
    `  - service: http://127.0.0.1:${port}`,
  ]
  fs.writeFileSync(cfConfigPath, lines.join('\n') + '\n', { mode: 0o600 })
}

function onCloudflaredLine(line) {
  if (!line.trim()) return
  console.log(line)
  const idx = /connIndex=(\d+)/.exec(line)?.[1]
  if (/Registered tunnel connection/.test(line) && idx !== undefined) {
    liveConns.set(idx, /location=(\S+)/.exec(line)?.[1] ?? '')
    backoffMs = 1000
    writeRuntime()
  } else if (idx !== undefined && /Unregistered tunnel connection|Connection terminated|Retrying connection|Serve tunnel error/.test(line)) {
    liveConns.delete(idx)
    writeRuntime()
  }
  if (/ ERR /.test(line)) {
    runtime.last_error = line.replace(/^\S+\s+ERR\s+/, '').slice(0, 300)
    writeRuntime()
  }
}

function pipeLines(stream) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      onCloudflaredLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  })
}

function startCloudflared(port) {
  writeCloudflaredConfig(port)
  const args = [
    'tunnel', '--no-autoupdate', '--no-prechecks', '--config', cfConfigPath,
    '--metrics', '127.0.0.1:0', '--grace-period', '2s', '--loglevel', 'info',
    'run', zone.tunnel_id,
  ]
  cf = spawn(zone.cloudflared || 'cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  runtime.cloudflared_pid = cf.pid
  writeRuntime()
  log(`cloudflared started (pid ${cf.pid}) tunnel ${zone.tunnel_id} → router http://127.0.0.1:${port}`)
  pipeLines(cf.stdout)
  pipeLines(cf.stderr)
  cf.on('error', (err) => {
    runtime.last_error = `spawn cloudflared: ${err.message}`
    log(runtime.last_error)
  })
  cf.on('exit', (code, signal) => {
    liveConns.clear()
    runtime.cloudflared_pid = null
    writeRuntime()
    if (stopping) return
    runtime.restarts += 1
    log(`cloudflared exited (code ${code}, signal ${signal}) — restarting in ${backoffMs} ms`)
    setTimeout(() => { if (!stopping) startCloudflared(port) }, backoffMs)
    backoffMs = Math.min(backoffMs * 2, 30000)
  })
}

// --------------------------------------------------------------- lifecycle ---
function shutdown(signal) {
  if (stopping) return
  stopping = true
  log(`${signal} — stopping`)
  const finish = () => {
    try { fs.unlinkSync(runtimePath) } catch { /* already gone */ }
    process.exit(0)
  }
  server.close()
  if (!cf || cf.exitCode !== null || cf.signalCode !== null) return finish()
  cf.once('exit', finish)
  cf.kill('SIGTERM')
  setTimeout(() => cf.kill('SIGTERM'), 150) // second SIGTERM = skip the grace period
  setTimeout(() => cf.kill('SIGKILL'), 2500)
  setTimeout(finish, 3000)
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal))
process.on('SIGHUP', () => loadRoutes('SIGHUP'))
process.on('exit', () => {
  try { if (cf && cf.exitCode === null) cf.kill('SIGKILL') } catch { /* gone */ }
})
fs.watchFile(routesPath, { interval: 500 }, (cur, prev) => {
  if (cur.mtimeMs !== prev.mtimeMs) loadRoutes('watch')
})

server.on('error', (err) => {
  log(`router error: ${err.message}`)
  process.exit(1)
})

loadRoutes('start')
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  runtime.proxy_port = port
  writeRuntime()
  log(`router on 127.0.0.1:${port} for zone ${zone.zone}`)
  startCloudflared(port)
})
