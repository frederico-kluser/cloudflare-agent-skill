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
 *      - Optional TOTP layer (auth.json, Google Authenticator): every route of the zone is
 *        behind it except the hosts listed in `exempt`. Read-only for the runner, hot-reloaded.
 *      - Optional boot-token injection (inject.json): GET "/" without ?token= and without a
 *        dsh-auth-* cookie gets `?token=<boot token>` appended before the proxy. HTTP only.
 *      Unknown host → 404. /__cfx-health → 200 (domain.py probes the edge with it).
 *   2. `cloudflared tunnel run` with a catch-all ingress to the router — never restarted when
 *      routes change. Restarted with backoff if it dies.
 *
 * Request order: /__cfx-health → TOTP (if enabled for that host) → routes + ?key= gate →
 * boot-token injection → proxy.
 *
 * Usage:   node zone-runner.mjs <zone-dir>     (zone.json + routes.json inside)
 * Reload:  SIGHUP (domain.py sends it and waits for runtime.json → routes_version), plus a
 *          500 ms routes.json watch as fallback. auth.json and inject.json have their own
 *          500 ms watch (routes_version is NOT touched by them).
 * Runtime: <zone-dir>/runtime.json (pid, proxy port, connections, ready, routes_version).
 * Stop:    SIGTERM/SIGINT → cloudflared gets a double SIGTERM (skips its grace period).
 * Never logs query strings (they carry tokens) nor any secret/token value.
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
const KEY_PARAM = 'key'
const COOKIE_NAME = '__cfx_sid'
const COOKIE_MAX_AGE = 31536000
const HEALTH_PATH = '/__cfx-health'
const TOTP_PATH = '/__cfx_totp__'
const TOTP_COOKIE = '__cfx_totp'
const TOTP_COOKIE_MAX_AGE = 43200 // 12 h
const TOTP_DIGITS = 6
const TOTP_PERIOD = 30
const TOTP_SKEW = 1
const AUTH_FILE = 'auth.json'
const INJECT_FILE = 'inject.json'
const AUTH_STATE_FILE = 'auth-state.json'
const WATCH_MS = 500
const INJECT_PARAM = 'token'
const DSH_COOKIE_PREFIX = 'dsh-auth-'
const TOTP_BODY_LIMIT = 4096
export const RATE_WINDOW_S = 300
export const RATE_MAX_FAILS = 5

const log = (msg) => console.log(`${new Date().toISOString()} [runner] ${msg}`)
const pathOnly = (url) => {
  try { return new URL(url, 'http://x').pathname } catch { return '?' }
}
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))
/** Header-safe host: lowercase, port stripped, no separators. */
const normalizeHost = (value) => String(value ?? '').trim().toLowerCase().replace(/:\d+$/, '')
const clampInt = (value, fallback, min, max) => {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

// Same derivation as domain.py boot_id(): Linux boot_id, macOS kern.boottime, else unknown.
let bootIdCache
function bootId() {
  if (bootIdCache !== undefined) return bootIdCache
  let id = 'unknown'
  try {
    id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    try {
      const sec = /sec = (\d+)/.exec(execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' }))?.[1]
      if (sec) id = `boot-${sec}`
    } catch { /* no sysctl */ }
  }
  bootIdCache = id || 'unknown'
  return bootIdCache
}

// ------------------------------------------------------------ pure helpers ---
/** RFC 6238 code for one counter (HMAC-SHA1, dynamic truncation, Ap. A). */
export function totpAt(secretHex, counter, digits = TOTP_DIGITS) {
  const key = Buffer.from(String(secretHex), 'hex')
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = crypto.createHmac('sha1', key).update(msg).digest()
  const offset = mac[19] & 0x0f
  const bin = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16)
    | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff)
  return String(bin % 10 ** digits).padStart(digits, '0')
}

/** Counter of the current period. `nowMs` is epoch milliseconds (Date.now()). */
export function counterAt(nowMs = Date.now(), period = TOTP_PERIOD) {
  return Math.floor(nowMs / 1000 / period)
}

/**
 * Verify a TOTP code against `secret_hex` inside a ±skew window, timing-safe.
 * `lastCounter` (last accepted counter, from auth-state.json) turns a valid-but-old code
 * into a replay rejection. Returns { ok: true, counter } | { ok: false, reason, counter? }.
 */
export function verifyTotp(secretHex, code, opts = {}) {
  const {
    now = Date.now(),
    skew = TOTP_SKEW,
    period = TOTP_PERIOD,
    digits = TOTP_DIGITS,
    lastCounter = -1,
  } = opts
  const secret = String(secretHex ?? '')
  if (!/^[0-9a-fA-F]+$/.test(secret) || secret.length % 2 !== 0 || secret.length < 2) {
    return { ok: false, reason: 'bad_secret' }
  }
  const candidate = String(code ?? '').trim()
  if (candidate.length !== digits || !/^\d+$/.test(candidate)) return { ok: false, reason: 'bad_code' }
  const wanted = Buffer.from(candidate)
  const t = counterAt(now, period)
  const offsets = [0]
  const span = Math.abs(Number(skew) || 0)
  for (let d = 1; d <= span; d += 1) offsets.push(-d, d)
  let match
  for (const d of offsets) {
    const counter = t + d
    if (counter < 0) continue
    const got = Buffer.from(totpAt(secret, counter, digits))
    if (got.length === wanted.length && crypto.timingSafeEqual(got, wanted)) { match = counter; break }
  }
  if (match === undefined) return { ok: false, reason: 'mismatch' }
  const last = Number(lastCounter)
  if (Number.isFinite(last) && last >= 0 && match <= last) return { ok: false, reason: 'replay', counter: match }
  return { ok: true, counter: match }
}

/** One cookie value by exact name (first match), or undefined. */
export function cookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** True when any cookie name starts with `prefix` (e.g. dsh-auth-). */
export function hasCookiePrefix(cookieHeader, prefix) {
  for (const part of String(cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=')
    const name = (eq === -1 ? part : part.slice(0, eq)).trim()
    if (name && name.startsWith(prefix)) return true
  }
  return false
}

/** True when the raw query string already carries `name` (handles "a=b" and "?a=b"). */
export function hasQueryParam(search, name) {
  const q = String(search ?? '').replace(/^\?/, '')
  if (!q) return false
  for (const pair of q.split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const raw = eq === -1 ? pair : pair.slice(0, eq)
    let key = raw
    try { key = decodeURIComponent(raw.replace(/\+/g, ' ')) } catch { /* keep raw */ }
    if (key === name) return true
  }
  return false
}

/**
 * Boot-token injection rule (HTTP GET only): exactly "/", no ?token= already, and no
 * DSH session cookie (dsh-auth-*) — otherwise the app answers 401 / loops.
 */
export function shouldInject(pathname, search, cookieHeader, injectEntry) {
  const token = injectEntry && typeof injectEntry.token === 'string' ? injectEntry.token : ''
  if (!token) return false
  if (pathname !== '/') return false
  if (hasQueryParam(search, INJECT_PARAM)) return false
  if (hasCookiePrefix(cookieHeader, DSH_COOKIE_PREFIX)) return false
  return true
}

/** Append ?token=… verbatim to the incoming request target (keeps the original query as-is). */
export function withBootToken(target, token) {
  const url = String(target ?? '/')
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}${INJECT_PARAM}=${encodeURIComponent(token)}`
}

/** Post-login redirect target: only path+query of our own origin (no open redirect, no CRLF). */
export function sanitizeNext(value, fallback = '/') {
  const raw = String(value ?? '')
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback
  try {
    const u = new URL(raw, 'http://x')
    return u.pathname + u.search
  } catch { return fallback }
}

/** Failure counter of the sliding window. Pure: returns the next persisted state. */
export function rateLimitStep(state, nowSec, { failed = true, window = RATE_WINDOW_S, max = RATE_MAX_FAILS } = {}) {
  const prevFails = Number(state?.fails) || 0
  const prevStart = Number(state?.fails_window_start) || 0
  const expired = !prevStart || (nowSec - prevStart) >= window
  const fails = failed ? (expired ? 1 : prevFails + 1) : 0
  const start = failed && !expired ? prevStart : nowSec
  return { fails, fails_window_start: start, limited: fails >= max }
}

/** True while the window still holds >= max failures. */
export function isRateLimited(state, nowSec, { window = RATE_WINDOW_S, max = RATE_MAX_FAILS } = {}) {
  const fails = Number(state?.fails) || 0
  const start = Number(state?.fails_window_start) || 0
  return fails >= max && start > 0 && (nowSec - start) < window
}

// ------------------------------------------------------------------ runner ---
export function main(argv = process.argv) {
  const zoneDir = argv[2]
  if (!zoneDir) {
    console.error('usage: zone-runner.mjs <zone-dir>')
    process.exit(2)
  }
  const zone = JSON.parse(fs.readFileSync(path.join(zoneDir, 'zone.json'), 'utf8'))
  const routesPath = path.join(zoneDir, 'routes.json')
  const runtimePath = path.join(zoneDir, 'runtime.json')
  const cfConfigPath = path.join(zoneDir, 'cloudflared.yml')
  const authPath = path.join(zoneDir, AUTH_FILE)
  const injectPath = path.join(zoneDir, INJECT_FILE)
  const authStatePath = path.join(zoneDir, AUTH_STATE_FILE)
  const zoneName = String(zone.zone ?? '')

  // -------------------------------------------------------------- runtime ---
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

  // ------------------------------------------------ auth.json / inject.json ---
  // Read-only for the runner (domain.py owns them), hot-reloaded by their own watch.
  let auth = { enabled: false, secret: '', digits: TOTP_DIGITS, period: TOTP_PERIOD, skew: TOTP_SKEW, exempt: new Set() }
  let authSignature = ''
  const totpSessions = new Map() // host -> Set<session id>
  let inject = new Map() // host -> { token }

  function loadAuth(reason) {
    let doc = null
    try {
      doc = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') log(`auth.json unreadable (${err.message}) — TOTP off`)
    }
    const t = doc?.totp ?? {}
    const secret = typeof t.secret_hex === 'string' ? t.secret_hex.trim().toLowerCase() : ''
    const digits = clampInt(t.digits, TOTP_DIGITS, 6, 8)
    const period = clampInt(t.period, TOTP_PERIOD, 1, 3600)
    const skew = clampInt(t.skew, TOTP_SKEW, 0, 3)
    const enabled = doc?.enabled === true && /^[0-9a-f]{40}$/.test(secret)
    if (doc?.enabled === true && !enabled) log('auth.json enabled but totp.secret_hex is not 40 hex chars — TOTP off')
    const exempt = new Set()
    for (const host of Array.isArray(doc?.exempt) ? doc.exempt : []) {
      const name = normalizeHost(host)
      if (name) exempt.add(name)
    }
    auth = { enabled, secret, digits, period, skew, exempt }
    const signature = enabled ? `${secret}|${digits}|${period}|${skew}` : ''
    if (signature !== authSignature) { // new secret/params: every TOTP session dies with the old one
      totpSessions.clear()
      authSignature = signature
    }
    log(`auth ${reason === 'start' ? 'loaded' : 'reloaded'} (exempt: ${exempt.size})${enabled ? '' : ' — TOTP off'}`)
  }

  function loadInject(reason) {
    let doc = null
    try {
      doc = JSON.parse(fs.readFileSync(injectPath, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') log(`inject.json unreadable (${err.message}) — injection off`)
    }
    const next = new Map()
    for (const [host, entry] of Object.entries(doc?.routes ?? {})) {
      const name = normalizeHost(host)
      const token = entry && typeof entry.token === 'string' ? entry.token : ''
      if (name && token) next.set(name, { token })
    }
    inject = next
    log(`inject ${reason === 'start' ? 'loaded' : 'reloaded'} (${next.size} host(s))`)
  }

  // auth-state.json — the runner is its only owner (atomic write, 0600).
  const state = { version: 1, last_counter: 0, fails: 0, fails_window_start: 0 }

  function loadState() {
    try {
      const doc = JSON.parse(fs.readFileSync(authStatePath, 'utf8'))
      state.last_counter = Number(doc?.last_counter) || 0
      state.fails = Number(doc?.fails) || 0
      state.fails_window_start = Number(doc?.fails_window_start) || 0
    } catch { /* no state yet — nothing recorded */ }
  }

  function saveState() {
    try {
      const tmp = `${authStatePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
      fs.renameSync(tmp, authStatePath)
    } catch (err) {
      log(`auth-state.json write failed: ${err.message}`)
    }
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
    loadAuth(reason) // SIGHUP/up/down reload everything; auth never touches routes_version
    loadInject(reason)
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
    const boot = bootId()
    for (const [host, r] of Object.entries(doc.routes ?? {})) {
      // ephemeral routes die with the boot they were created in
      if (!r.persist && r.boot_id && boot !== 'unknown' && r.boot_id !== boot) continue
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

  // ------------------------------------------------------------ TOTP layer ---
  const nowSec = () => Math.floor(Date.now() / 1000)
  const totpRequired = (route) => auth.enabled && !auth.exempt.has(route.host)

  function totpCookieOk(host, req) {
    const sid = cookieValue(req.headers.cookie, TOTP_COOKIE)
    return Boolean(sid) && totpSessions.get(host)?.has(sid) === true
  }

  function totpForm(next, error) {
    return '<!doctype html>\n'
      + '<html lang="pt-BR"><head><meta charset="utf-8">\n'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
      + `<title>${escapeHtml(zoneName)} — verificação TOTP</title>\n`
      + '<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;'
      + 'font:16px/1.45 system-ui,sans-serif;background:#0f1115;color:#e8eaed}'
      + 'main{width:min(92vw,22rem);padding:1.5rem;border:1px solid #2a2f3a;border-radius:12px;background:#161a21}'
      + 'h1{margin:0 0 .35rem;font-size:1.05rem}p{margin:.2rem 0 1rem;color:#9aa4b2;font-size:.9rem}'
      + 'form{display:grid;gap:.6rem}input{font:inherit;padding:.7rem .8rem;border-radius:8px;'
      + 'border:1px solid #2a2f3a;background:#0f1115;color:inherit;letter-spacing:.3em;text-align:center}'
      + 'button{font:inherit;padding:.7rem;border:0;border-radius:8px;background:#3b82f6;color:#fff;cursor:pointer}'
      + '.err{color:#f87171}</style></head>\n'
      + `<body><main><h1>${escapeHtml(zoneName)} — verificação TOTP</h1>\n`
      + '<p>Abre o Google Authenticator e escreve o código de 6 dígitos.</p>\n'
      + (error ? `<p class="err">${escapeHtml(error)}</p>\n` : '')
      + `<form method="post" action="${TOTP_PATH}">\n`
      + `<input type="hidden" name="next" value="${escapeHtml(next)}">\n`
      + `<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="${auth.digits}" required autofocus aria-label="código TOTP">\n`
      + '<button type="submit">entrar</button>\n'
      + '</form></main></body></html>'
  }

  function totpChallenge(req, res, error) {
    const next = encodeURIComponent(req.url ?? '/') // hidden "next": the whole target, urlencoded
    res.writeHead(401, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end(totpForm(next, error))
  }

  const tooMany = (_req, res) => {
    res.writeHead(403, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end('muitas tentativas, aguarde\n')
  }

  function readBody(req, limit, done) {
    let body = ''
    let over = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (over) return
      body += chunk
      if (body.length > limit) over = true
    })
    req.on('end', () => (over ? done(new Error('body too large'), '') : done(null, body)))
    req.on('error', (err) => done(err, ''))
  }

  function totpPost(route, req, res) {
    const now = nowSec()
    if (isRateLimited(state, now)) return tooMany(req, res)
    readBody(req, TOTP_BODY_LIMIT, (err, body) => {
      if (err) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('pedido inválido\n')
        return
      }
      const form = new URLSearchParams(body)
      const next = sanitizeNext(form.get('next'))
      const result = verifyTotp(auth.secret, form.get('code'), {
        now: Date.now(), skew: auth.skew, period: auth.period, digits: auth.digits,
        lastCounter: state.last_counter,
      })
      if (!result.ok) {
        const after = rateLimitStep(state, now)
        state.fails = after.fails
        state.fails_window_start = after.fails_window_start
        saveState()
        log(`${route.host}: TOTP rejected (${result.reason})`)
        if (after.limited) return tooMany(req, res)
        return totpChallenge(req, res, result.reason === 'replay'
          ? 'código já usado — espera o próximo.'
          : 'código inválido, tenta de novo.')
      }
      state.last_counter = result.counter
      state.fails = 0
      state.fails_window_start = now
      saveState()
      const sid = crypto.randomBytes(24).toString('base64url')
      let sessions = totpSessions.get(route.host)
      if (!sessions) {
        sessions = new Set()
        totpSessions.set(route.host, sessions)
      }
      sessions.add(sid)
      log(`${route.host}: TOTP accepted (counter ${result.counter})`)
      res.writeHead(303, {
        location: next,
        'set-cookie': `${TOTP_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${TOTP_COOKIE_MAX_AGE}`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      res.end()
    })
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

  const sessionIdFrom = (req) => cookieValue(req.headers.cookie, COOKIE_NAME)

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
        'set-cookie': `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${COOKIE_MAX_AGE}`,
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
    return routes.get(normalizeHost(req.headers.host))
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
    // 1) TOTP before anything else (health excluded above; exempt hosts skip it entirely)
    if (totpRequired(route) && !totpCookieOk(route.host, req)) {
      if (isRateLimited(state, nowSec())) return tooMany(req, res)
      if (req.method === 'POST' && pathOnly(req.url) === TOTP_PATH) return totpPost(route, req, res)
      if (req.method === 'GET' || req.method === 'HEAD') return totpChallenge(req, res)
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
      res.end('401 Unauthorized — autenticação TOTP necessária\n')
      return
    }
    // 2) existing ?key= gate
    if (!gate(route, req, res)) return
    // 3) boot-token injection (HTTP GET "/" only, never when the app already has a session)
    let target = req.url
    const entry = inject.get(route.host)
    if (entry && req.method === 'GET') {
      const u = new URL(req.url, 'http://x')
      if (shouldInject(u.pathname, u.search, req.headers.cookie, entry)) target = withBootToken(req.url, entry.token)
    }
    // 4) proxy
    const upReq = route.transport.request({
      host: route.connectHost,
      port: route.port,
      method: req.method,
      path: target,
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

  // WebSocket (and any Upgrade): TOTP first (no form here — 401 straight away), then the
  // ?key= gate, then relay the handshake with the same header rewrite and splice the
  // sockets — the upstream's 101 (or error) goes back verbatim.
  server.on('upgrade', (req, socket, head) => {
    const deny = (line) => socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    const route = routeFor(req)
    if (!route) return deny('404 Not Found')
    if (totpRequired(route) && !totpCookieOk(route.host, req)) return deny('401 Unauthorized')
    if (route.gate && !route.sessions.has(sessionIdFrom(req))) return deny('401 Unauthorized')
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

  // ------------------------------------------------------------- cloudflared ---
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

  // -------------------------------------------------------------- lifecycle ---
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
  fs.watchFile(routesPath, { interval: WATCH_MS }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) loadRoutes('watch')
  })
  // auth/inject have their own watch: editing auth.json must NOT move routes_version
  // (domain.py waits for that value on up/down).
  fs.watchFile(authPath, { interval: WATCH_MS }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) loadAuth('watch')
  })
  fs.watchFile(injectPath, { interval: WATCH_MS }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs) loadInject('watch')
  })

  server.on('error', (err) => {
    log(`router error: ${err.message}`)
    process.exit(1)
  })

  loadState()
  loadRoutes('start') // also loads auth.json + inject.json
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    runtime.proxy_port = port
    writeRuntime()
    log(`router on 127.0.0.1:${port} for zone ${zone.zone}`)
    startCloudflared(port)
  })
  return server
}

// Only start when executed directly (`node zone-runner.mjs <zone-dir>`), so tests can import
// the pure helpers without listening on anything.
const selfPath = fileURLToPath(import.meta.url)
let entryPath = process.argv[1] ?? ''
try { entryPath = fs.realpathSync(entryPath) } catch { /* not a file — leave as is */ }
if (entryPath && entryPath === selfPath) main()
