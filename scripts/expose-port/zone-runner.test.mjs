/**
 * zone-runner.test.mjs — testes da camada TOTP/injeção do zone-runner.mjs (node --test).
 *
 * Nada aqui toca produção: o E2E corre num zone-dir criado com mkdtemp (portas efémeras,
 * upstream falso, cloudflared substituído por um stub que só dorme). O zone-dir real
 * (~/.local/state/cloudflare-agent-skill/zones/kluser.me) e a unit cfx-zone@… não são tocados.
 *
 * Nunca imprime secret/token: as asserções comparam valores, não os mostram.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  totpAt, verifyTotp, shouldInject, rateLimitStep, isRateLimited, sanitizeNext,
  RATE_MAX_FAILS, RATE_WINDOW_S,
} from './zone-runner.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(HERE, 'zone-runner.mjs')
const RFC_SECRET = '3132333435363738393031323334353637383930' // "12345678901234567890"
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }

// ---------------------------------------------------------------- vetores ---
// RFC 6238 Apêndice B (SHA-1): a tabela publicada é de 8 dígitos. Com digits=6 o valor é
// bin % 10^6 — o mesmo que o Google Authenticator calcula.
const RFC_VECTORS = [
  { t: 59, eight: '94287082', six: '287082' },
  { t: 1111111109, eight: '07081804', six: '081804' },
  { t: 1111111111, eight: '14050471', six: '050471' },
  { t: 1234567890, eight: '89005924', six: '005924' },
  { t: 2000000000, eight: '69279037', six: '279037' },
  { t: 20000000000, eight: '65353130', six: '353130' },
]

test('RFC 6238 Ap.B: tabela de 8 dígitos e recorte de 6 dígitos (%10^6)', () => {
  for (const { t, eight, six } of RFC_VECTORS) {
    const counter = Math.floor(t / 30)
    assert.equal(totpAt(RFC_SECRET, counter, 8), eight, `8 dígitos em t=${t}`)
    assert.equal(totpAt(RFC_SECRET, counter, 6), six, `6 dígitos em t=${t}`)
    assert.equal(totpAt(RFC_SECRET, counter), six, `default digits=6 em t=${t}`)
  }
})

test('GUESS/divergência: o 653531 do briefing NÃO é %10^6 (é o valor de 8 dígitos sem os 2 últimos)', () => {
  const counter = Math.floor(20000000000 / 30) // 666666666
  assert.equal(totpAt(RFC_SECRET, counter, 8), '65353130') // RFC, 8 dígitos — confere
  assert.equal(totpAt(RFC_SECRET, counter, 6), '353130') // bin % 10^6 = Google Authenticator
  assert.notEqual(totpAt(RFC_SECRET, counter, 6), '653531') // floor(bin/100) — incompatível
  // e a mesma incoerência no 1.º vetor do briefing: bin%10^6=287082 mas os 6 primeiros
  // dígitos do valor de 8 dígitos dariam 942870 — nenhuma fórmula serve os 6 vetores do
  // briefing ao mesmo tempo.
  assert.equal(totpAt(RFC_SECRET, 1, 6), '287082')
  assert.equal(totpAt(RFC_SECRET, 1, 8), '94287082')
})

// -------------------------------------------------------------- verifyTotp ---
test('verifyTotp: aceita T e T±1, rejeita T±2, lixo e replay', () => {
  const counter = 1111111111
  const now = counter * 30 * 1000 // epoch ms
  const code = totpAt(RFC_SECRET, counter)

  const ok = verifyTotp(RFC_SECRET, code, { now })
  assert.equal(ok.ok, true)
  assert.equal(ok.counter, counter)

  for (const d of [-1, 1]) {
    const near = verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, counter + d), { now })
    assert.equal(near.ok, true, `T${d > 0 ? '+' : ''}${d} devia ser aceite`)
    assert.equal(near.counter, counter + d)
  }
  for (const d of [-2, 2]) {
    const far = verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, counter + d), { now })
    assert.equal(far.ok, false, `T${d > 0 ? '+' : ''}${d} devia ser rejeitado`)
    assert.equal(far.reason, 'mismatch')
  }

  // skew=0 fecha a janela
  assert.equal(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, counter - 1), { now, skew: 0 }).ok, false)

  // lixo
  for (const junk of ['', '12345', '1234567', 'abcdef', '  12  ', '00000a']) {
    const bad = verifyTotp(RFC_SECRET, junk, { now })
    assert.equal(bad.ok, false, `lixo ${JSON.stringify(junk)} devia falhar`)
  }
  for (const badSecret of ['zz-not-hex', 'abc', '', undefined, '31323']) {
    assert.equal(verifyTotp(badSecret, code, { now }).reason, 'bad_secret', `secret inválido ${JSON.stringify(badSecret)}`)
  }
  // secret curto mas hex par é aceite pela função pura (quem impõe os 40 hex é o loadAuth)
  assert.equal(verifyTotp('3132', code, { now }).ok, false)
  assert.equal(verifyTotp('3132', code, { now }).reason, 'mismatch')

  // replay: counter <= último aceite
  const replay = verifyTotp(RFC_SECRET, code, { now, lastCounter: counter })
  assert.equal(replay.ok, false)
  assert.equal(replay.reason, 'replay')
  const replayPrevious = verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, counter - 1), { now, lastCounter: counter })
  assert.equal(replayPrevious.ok, false)
  assert.equal(replayPrevious.reason, 'replay')
  // o código seguinte continua a passar
  const next = verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, counter + 1), { now, lastCounter: counter })
  assert.equal(next.ok, true)
  assert.equal(next.counter, counter + 1)
})

test('sanitizeNext: só path+query do próprio host', () => {
  assert.equal(sanitizeNext('/trello?a=1'), '/trello?a=1')
  assert.equal(sanitizeNext('/'), '/')
  assert.equal(sanitizeNext(undefined), '/')
  assert.equal(sanitizeNext(''), '/')
  assert.equal(sanitizeNext('https://evil.example/x'), '/')
  assert.equal(sanitizeNext('//evil.example/x'), '/')
  assert.equal(sanitizeNext('/ok\r\nSet-Cookie: x=1'), '/')
  assert.equal(sanitizeNext('relativo'), '/')
  assert.equal(sanitizeNext('https://teste.kluser.me/x'), '/') // host absoluto: nunca passa
})

// ------------------------------------------------------------- rate limit ---
test(`rate limit: a ${RATE_MAX_FAILS}.ª falha na janela de ${RATE_WINDOW_S}s bloqueia`, () => {
  const now = 1_700_000_000
  let state = { fails: 0, fails_window_start: 0 }
  for (let attempt = 1; attempt <= RATE_MAX_FAILS; attempt += 1) {
    assert.equal(isRateLimited(state, now), false, `não pode bloquear antes da ${RATE_MAX_FAILS}.ª`)
    state = rateLimitStep(state, now)
    assert.equal(state.fails, attempt)
    assert.equal(state.limited, attempt >= RATE_MAX_FAILS)
    assert.equal(isRateLimited(state, now), attempt >= RATE_MAX_FAILS)
  }
  // 6.ª tentativa continua bloqueada dentro da janela
  assert.equal(isRateLimited(rateLimitStep(state, now + 10), now + 10), true)
  // janela expira ⇒ desbloqueia
  assert.equal(isRateLimited(state, now + RATE_WINDOW_S), false)
  assert.equal(rateLimitStep(state, now + RATE_WINDOW_S).fails, 1)
  // sucesso zera
  const cleared = rateLimitStep(state, now, { failed: false })
  assert.equal(cleared.fails, 0)
  assert.equal(cleared.limited, false)
  assert.equal(isRateLimited(cleared, now), false)
})

// ------------------------------------------------------------ shouldInject ---
test('shouldInject: só GET "/" sem token e sem cookie dsh-auth-*', () => {
  const entry = { token: 'tok-123' }
  const table = [
    // [pathname, search, cookie, entrada, esperado, nota]
    ['/', '', undefined, entry, true, 'caso base'],
    ['/', '', '__cfx_totp=abc', entry, true, 'cookie do TOTP não interfere'],
    ['/', '', '__cfx_sid=abc', entry, true, 'cookie do gate não interfere'],
    ['/', '', undefined, { token: 'tok-123' }, true, 'entrada com token'],
    ['/', '', 'dsh-auth-abc=1', entry, false, 'sessão DSH existente'],
    ['/', '', 'a=1; dsh-auth-abc=1; b=2', entry, false, 'cookie DSH no meio'],
    ['/', '', 'xdsh-auth-1=1', entry, true, 'prefixo tem de estar no início do nome'],
    ['/', '', 'dsh-auth=1', entry, true, 'sem o hífen final não é o cookie do DSH (COOKIE_PREFIX = "dsh-auth-")'],
    ['/', '', ' dsh-auth-abc = 1 ', entry, false, 'espaços à volta do nome'],
    ['/', '?token=zzz', undefined, entry, false, 'já tem ?token='],
    ['/', '?a=1&token=zzz', undefined, entry, false, 'token no meio da query'],
    ['/', '?TOKEN=zzz', undefined, entry, true, 'nome do parâmetro é case-sensitive'],
    ['/', '?a=1', undefined, entry, true, 'outros parâmetros passam'],
    ['/', '?notext=1', undefined, entry, true, 'não confundir com token'],
    ['/api', '', undefined, entry, false, 'path ≠ /'],
    ['/index.html', '', undefined, entry, false, 'path ≠ /'],
    ['/', '', undefined, undefined, false, 'sem entrada no inject.json'],
    ['/', '', undefined, { token: '' }, false, 'token vazio'],
    ['/', '', undefined, {}, false, 'entrada sem token'],
  ]
  for (const [pathname, search, cookie, injectEntry, expected, note] of table) {
    assert.equal(shouldInject(pathname, search, cookie, injectEntry), expected, note)
  }
})

// -------------------------------------------------------------------- E2E ---
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })

async function waitFor(fn, { timeout = 10000, interval = 100, what = 'condição' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout à espera de ${what}`)
    await delay(interval)
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function request(port, { method = 'GET', target = '/', host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: target,
      headers: host ? { host, ...headers } : headers,
      setHost: false,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function rawRequest(port, payload, ms = 3000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload))
    const timer = setTimeout(() => socket.destroy(), ms)
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { buf += chunk })
    socket.on('close', () => { clearTimeout(timer); resolve(buf) })
    socket.on('end', () => { clearTimeout(timer); resolve(buf) })
    socket.on('error', reject)
  })
}

function waitExit(child, ms) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      resolve()
    }, ms)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

test('E2E: form 401 → TOTP → cookie → injeção do ?token= → isento → replay/rate limit → reload', { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-zone-test-'))
  const HOST = 'teste.kluser.me'
  const EXEMPT = 'exempt.kluser.me'
  const GATE_HOST = 'gate.kluser.me'
  const GATE_KEY = `chave-de-teste-${crypto.randomBytes(8).toString('hex')}` // >= 16 chars
  const secret = crypto.randomBytes(20).toString('hex') // 40 hex chars = 20 bytes
  const bootToken = `boot-${crypto.randomBytes(8).toString('hex')}`
  const injected = `/?token=${encodeURIComponent(bootToken)}`
  const seen = [] // o que o upstream recebeu (path verbatim)
  const upstream = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('UPSTREAM-OK')
  })
  let runner
  let runnerLog = ''

  try {
    const upPort = await listen(upstream)
    const cfStub = path.join(dir, 'cloudflared-stub.sh')
    fs.writeFileSync(cfStub, '#!/bin/sh\nexec sleep 900\n', { mode: 0o755 })
    fs.writeFileSync(path.join(dir, 'zone.json'), JSON.stringify({
      version: 2,
      zone: 'kluser.me',
      zone_id: 'test-zone-id',
      account_id: 'test-account-id',
      tunnel_id: '00000000-0000-0000-0000-000000000000',
      credentials_file: path.join(dir, 'creds.json'),
      cloudflared: cfStub,
    }))
    fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify({
      version: 7,
      routes: {
        [HOST]: { upstream: `http://127.0.0.1:${upPort}`, persist: true },
        [EXEMPT]: { upstream: `http://127.0.0.1:${upPort}`, persist: true },
        [GATE_HOST]: { upstream: `http://127.0.0.1:${upPort}`, persist: true, gate: true, gate_token: GATE_KEY },
      },
    }))
    const authDoc = {
      version: 1,
      totp: { secret_hex: secret, digits: 6, period: 30, skew: 1 },
      exempt: [EXEMPT],
      enabled: true,
    }
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(authDoc), { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'inject.json'), JSON.stringify({
      version: 1,
      routes: { [HOST]: { token: bootToken } },
    }), { mode: 0o600 })

    runner = spawn(process.execPath, [RUNNER, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
    runner.stdout.setEncoding('utf8')
    runner.stderr.setEncoding('utf8')
    runner.stdout.on('data', (chunk) => { runnerLog += chunk })
    runner.stderr.on('data', (chunk) => { runnerLog += chunk })

    const runtime = await waitFor(() => {
      try {
        const rt = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'))
        return rt.proxy_port ? rt : null
      } catch { return null }
    }, { what: 'runtime.json com proxy_port', timeout: 20000 })
    const port = runtime.proxy_port
    assert.equal(runtime.routes_version, 7)
    assert.notEqual(port, 62324, 'porta efémera, nunca a de produção')
    const call = (opts = {}) => request(port, { host: HOST, ...opts })

    // (a) sem cookie ⇒ 401 com form TOTP, upstream intocado
    const challenge = await call({ target: '/' })
    assert.equal(challenge.status, 401)
    assert.match(String(challenge.headers['content-type']), /text\/html/)
    assert.equal(challenge.headers['cache-control'], 'no-store')
    assert.equal(challenge.headers['referrer-policy'], 'no-referrer')
    for (const needle of ['action="/__cfx_totp__"', 'name="code"', 'inputmode="numeric"', 'name="next"', 'verificação TOTP', '<form']) {
      assert.ok(challenge.body.includes(needle), `form 401 sem ${needle}`)
    }
    assert.equal(seen.length, 0, 'o upstream não pode ser tocado antes do TOTP')

    // ...e o health continua livre e antes de tudo
    const health = await call({ target: '/__cfx-health' })
    assert.equal(health.status, 200)
    assert.equal(health.body, 'ok')

    // (b) POST com código correto ⇒ 303 + Set-Cookie de sessão TOTP
    const code = totpAt(secret, Math.floor(Date.now() / 1000 / 30))
    const login = await call({
      method: 'POST',
      target: '/__cfx_totp__',
      headers: FORM,
      body: `code=${encodeURIComponent(code)}&next=${encodeURIComponent('/trello?a=1')}`,
    })
    assert.equal(login.status, 303)
    assert.equal(login.headers.location, '/trello?a=1')
    assert.equal(login.headers['cache-control'], 'no-store')
    const setCookie = String(login.headers['set-cookie']?.[0] ?? '')
    assert.match(setCookie, /^__cfx_totp=[A-Za-z0-9_-]{32}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=43200$/)
    const sid = setCookie.slice('__cfx_totp='.length, setCookie.indexOf(';'))

    // auth-state.json: dono único do runner, 0600, last_counter gravado e fails zeradas
    const statePath = path.join(dir, 'auth-state.json')
    const stateDoc = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    assert.equal(stateDoc.version, 1)
    assert.ok(stateDoc.last_counter > 0, 'last_counter tem de ficar gravado')
    assert.equal(stateDoc.fails, 0)
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600)
    assert.ok(!fs.existsSync(`${statePath}.tmp`), 'tmp do rename atómico não pode ficar para trás')

    // (c) replay do mesmo código ⇒ 401 outra vez (e sem cookie novo)
    const replay = await call({
      method: 'POST',
      target: '/__cfx_totp__',
      headers: FORM,
      body: `code=${encodeURIComponent(code)}&next=${encodeURIComponent('/')}`,
    })
    assert.equal(replay.status, 401)
    assert.equal(replay.headers['set-cookie'], undefined)

    // (d) com cookie ⇒ chega ao upstream COM o ?token= injetado
    seen.length = 0
    const ok = await call({ target: '/', headers: { cookie: `__cfx_totp=${sid}` } })
    assert.equal(ok.status, 200)
    assert.equal(ok.body, 'UPSTREAM-OK')
    assert.equal(seen.at(-1).url, injected, 'o upstream tem de receber o token injetado')
    assert.equal(seen.at(-1).host, `127.0.0.1:${upPort}`, 'Host reescrito para o upstream')

    // (d2) variantes: query pré-existente acrescenta; cookie dsh-auth-* e ?token= passam verbatim
    await call({ target: '/?a=1', headers: { cookie: `__cfx_totp=${sid}` } })
    assert.equal(seen.at(-1).url, `/?a=1&token=${encodeURIComponent(bootToken)}`)
    await call({ target: '/', headers: { cookie: `__cfx_totp=${sid}; dsh-auth-abc=1` } })
    assert.equal(seen.at(-1).url, '/', 'com sessão DSH não injeta')
    await call({ target: '/api', headers: { cookie: `__cfx_totp=${sid}` } })
    assert.equal(seen.at(-1).url, '/api', 'path ≠ / não injeta')
    await call({ target: '/?token=ja-tem', headers: { cookie: `__cfx_totp=${sid}` } })
    assert.equal(seen.at(-1).url, '/?token=ja-tem', 'token já presente passa verbatim')

    // (e) host isento ⇒ sem TOTP e sem injeção (não tem entrada no inject.json)
    seen.length = 0
    const exempt = await request(port, { host: EXEMPT, target: '/' })
    assert.equal(exempt.status, 200)
    assert.equal(exempt.body, 'UPSTREAM-OK')
    assert.equal(seen.at(-1).url, '/', 'isento chega ao upstream sem TOTP e sem token')

    // (f) upgrade WS sem cookie ⇒ 401 direto (não há form num upgrade)
    const wsDenied = await rawRequest(port,
      `GET /ws HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
    assert.match(wsDenied, /^HTTP\/1\.1 401 /, 'upgrade sem cookie tem de levar 401')

    // (f2) retrocompatibilidade: health antes de tudo (mesmo em host desconhecido), 404 fora
    const unknownHost = await request(port, { host: 'nao-existe.kluser.me', target: '/' })
    assert.equal(unknownHost.status, 404)
    const healthUnknown = await request(port, { host: 'nao-existe.kluser.me', target: '/__cfx-health' })
    assert.equal(healthUnknown.status, 200)

    // (f3) ordem TOTP → gate ?key= → proxy, e a sessão TOTP é por host
    const gateNoCookie = await request(port, { host: GATE_HOST, target: '/' })
    assert.equal(gateNoCookie.status, 401)
    assert.ok(gateNoCookie.body.includes('<form'), 'o TOTP vem antes do ?key=')
    // a sessão do TOTP não serve noutro host (o cookie é host-only no browser)
    const crossHost = await request(port, { host: GATE_HOST, target: '/', headers: { cookie: `__cfx_totp=${sid}` } })
    assert.equal(crossHost.status, 401, 'sessão TOTP é por host')
    assert.ok(crossHost.body.includes('<form'))
    // e o código do mesmo período não pode ser reaproveitado noutro host (replay global)
    const replayOtherHost = await request(port, {
      host: GATE_HOST,
      method: 'POST',
      target: '/__cfx_totp__',
      headers: FORM,
      body: `code=${encodeURIComponent(code)}&next=%2F`,
    })
    assert.equal(replayOtherHost.status, 401, 'counter já aceite não volta a valer')

    // (g) rate limit: a 5.ª falha na janela ⇒ 403 "muitas tentativas" (o replay acima = 1 falha)
    const bad = { method: 'POST', target: '/__cfx_totp__', headers: FORM, body: 'code=12345&next=%2F' }
    let last
    for (let attempt = 2; attempt <= RATE_MAX_FAILS; attempt += 1) last = await call(bad)
    assert.equal(last.status, 403)
    assert.match(last.body, /muitas tentativas, aguarde/)
    assert.ok(!last.body.includes('<form'), '403 não leva form')
    const stillLimited = await call({ target: '/' })
    assert.equal(stillLimited.status, 403)
    assert.ok(!stillLimited.body.includes('<form'))

    // (h) watch do auth.json: enabled:false ⇒ TOTP sai de cena sozinho (sem SIGHUP)
    fs.writeFileSync(path.join(dir, 'auth.json'),
      JSON.stringify({ ...authDoc, enabled: false }), { mode: 0o600 })
    const afterReload = await waitFor(async () => {
      const res = await call({ target: '/' })
      return res.status === 200 ? res : null
    }, { what: 'reload do auth.json (watch 500ms)', timeout: 15000, interval: 250 })
    assert.equal(afterReload.body, 'UPSTREAM-OK')
    assert.equal(seen.at(-1).url, injected)
    assert.match(runnerLog, /auth (loaded|reloaded) \(exempt: 1\)/)
    assert.match(runnerLog, /inject (loaded|reloaded) \(1 host\(s\)\)/)

    // (h2) retrocompatibilidade: auth.json ausente ⇒ comportamento de antes (routeFor normal)
    fs.unlinkSync(path.join(dir, 'auth.json'))
    await waitFor(() => /auth reloaded \(exempt: 0\)/.test(runnerLog),
      { what: 'reload sem auth.json', timeout: 15000, interval: 250 })
    const noAuth = await call({ target: '/' })
    assert.equal(noAuth.status, 200)
    assert.equal(noAuth.body, 'UPSTREAM-OK')
    assert.equal(seen.at(-1).url, injected, 'sem auth.json a injeção continua a funcionar')
    // o host isento nunca viu TOTP e o 404 continua igual
    assert.equal((await request(port, { host: EXEMPT, target: '/' })).status, 200)
    assert.equal((await request(port, { host: 'nao-existe.kluser.me', target: '/' })).status, 404)
    // routes_version nunca é mexido pelo auth/inject
    const rtFinal = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json'), 'utf8'))
    assert.equal(rtFinal.routes_version, 7)

    // (i) com o auth fora do caminho, o gate ?key= antigo continua idêntico
    const gate401 = await request(port, { host: GATE_HOST, target: '/' })
    assert.equal(gate401.status, 401)
    assert.ok(gate401.body.includes('?key='), 'mensagem do gate ?key= intacta')
    const gateBad = await request(port, { host: GATE_HOST, target: '/?key=chave-errada-comprida' })
    assert.equal(gateBad.status, 401)
    const gateOk = await request(port, { host: GATE_HOST, target: `/?key=${encodeURIComponent(GATE_KEY)}` })
    assert.equal(gateOk.status, 302)
    assert.equal(gateOk.headers.location, '/', 'o ?key= sai da location')
    const gateSetCookie = String(gateOk.headers['set-cookie']?.[0] ?? '')
    assert.match(gateSetCookie, /^__cfx_sid=[A-Za-z0-9_-]{32}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=31536000$/)
    const cfxSid = gateSetCookie.slice('__cfx_sid='.length, gateSetCookie.indexOf(';'))
    seen.length = 0
    const gatePass = await request(port, { host: GATE_HOST, target: '/', headers: { cookie: `__cfx_sid=${cfxSid}` } })
    assert.equal(gatePass.status, 200)
    assert.equal(gatePass.body, 'UPSTREAM-OK')
    assert.equal(seen.at(-1).url, '/', 'sem entrada no inject.json ⇒ verbatim')
  } catch (err) {
    // pista útil sem vazar segredos (o runner nunca regista tokens nem o secret)
    err.message += `\n--- runner.log (tail) ---\n${runnerLog.split('\n').slice(-12).join('\n')}`
    throw err
  } finally {
    if (runner) {
      runner.kill('SIGTERM')
      await waitExit(runner, 5000)
    }
    await new Promise((resolve) => upstream.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
