/**
 * Tests for dsh-office-render.
 *
 * Two layers, on purpose:
 *
 * 1. **The core**, driven directly: extension classification, result parsing,
 *    queue serialization, eviction policy. These are the decisions that are
 *    wrong silently, so they get asserted rather than exercised by hand.
 *
 * 2. **The host half end to end**, with a fake Cordis context capturing the
 *    routes it registers and fake Node req/res objects driving them. That
 *    exercises the real handler, the real cache, and the real converter
 *    invocation — the parts a pure unit test cannot reach. The conversion test
 *    skips itself (loudly) on a machine with no Office suite, so the suite stays
 *    honest instead of green-by-accident.
 *
 * Run: `npm test`
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = mkdtempSync(join(tmpdir(), 'dsh-office-render-test-'))

await build({
  absWorkingDir: root,
  entryPoints: ['src/host/render-core.ts', 'src/index.ts'],
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['node:*'],
  logLevel: 'warning',
})

const core = await import(pathToFileURL(join(outDir, 'host', 'render-core.mjs')).href)
const host = await import(pathToFileURL(join(outDir, 'index.mjs')).href)

// ── a minimal, correct zip writer (fixture only) ─────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** Build a stored-and-deflated zip from `{ name, data }` entries. */
function zip(entries) {
  const locals = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const payload = deflateRawSync(raw)
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, payload)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(payload.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, name)

    offset += local.length + name.length + payload.length
  }

  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return new Uint8Array(Buffer.concat([...locals, directory, eocd]))
}

/**
 * The smallest .docx that is still a real .docx: package relationships plus one
 * body. Used as the conversion fixture so the end-to-end test needs nothing from
 * the outside world (and no user document is ever shipped in this repo).
 */
const MINIMAL_DOCX = zip([
  {
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  },
  {
    name: '_rels/.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  },
  {
    name: 'word/document.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>office-render self-test</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`,
  },
])

// ── a fake host context + fake Node req/res ──────────────────────────────────

/** Capture the routes `apply` registers, and swallow the disposers. */
function mountHost() {
  const routes = []
  const logs = []
  const ctx = {
    effect(factory) {
      factory()
      return () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  const originalLog = console.log
  const originalWarn = console.warn
  console.log = (...args) => logs.push(args.join(' '))
  console.warn = (...args) => logs.push(args.join(' '))
  try {
    host.apply(ctx)
  } finally {
    console.log = originalLog
    console.warn = originalWarn
  }
  return { routes, logs }
}

/** A request that emits one body buffer. */
function fakeRequest({ url, method = 'GET', body, headers = {} }) {
  const listeners = { data: [], end: [], error: [] }
  return {
    url,
    method,
    headers,
    on(event, listener) {
      listeners[event]?.push(listener)
      if (event === 'end') {
        // Deliver the body on the next tick, after the handler has subscribed.
        queueMicrotask(() => {
          if (body !== undefined) for (const deliver of listeners.data) deliver(body)
          for (const finish of listeners.end) finish()
        })
      }
    },
  }
}

/** A response that records what the handler wrote. */
function fakeResponse() {
  const headers = {}
  const chunks = []
  let status = 0
  let ended = false
  return {
    set statusCode(value) {
      status = value
    },
    get statusCode() {
      return status
    },
    setHeader(name, value) {
      headers[name.toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
      ended = true
    },
    result() {
      return { status, headers, body: Buffer.concat(chunks), ended }
    },
  }
}

/** Drive one route handler and return what it wrote. */
async function callRoute(route, options) {
  const response = fakeResponse()
  await route.handler(fakeRequest(options), response)
  return response.result()
}

// ── assertions ───────────────────────────────────────────────────────────────

let checks = 0
let skipped = 0
const check = async (label, fn) => {
  await fn()
  checks++
  console.log(`  ok  ${label}`)
}
const skip = label => {
  skipped++
  console.log(`  --  ${label}`)
}

console.log('dsh-office-render :: office render core')

await check('only the extensions we can actually convert are claimed', () => {
  assert.equal(core.kindOfExtension('docx'), 'docx')
  assert.equal(core.kindOfExtension('.DOCX'), 'docx')
  assert.equal(core.kindOfExtension('pptm'), 'pptx')
  assert.equal(core.kindOfExtension('potx'), 'pptx')
  // A spreadsheet is not ours: claiming it would break the sibling plugin that
  // really does handle it.
  assert.equal(core.kindOfExtension('xlsx'), undefined)
  assert.equal(core.kindOfExtension('pdf'), undefined)
  assert.equal(core.kindOfExtension(''), undefined)
  assert.equal(core.isConvertible('xlsx'), false)
})

await check('the converter result is read from the LAST json line, banners tolerated', () => {
  const noisy = ['WPS Office (C) Kingsoft', '{"ok":false,"error":"warmup"}', '{"ok":true,"engine":"KWPP.Application","bytes":42}'].join(
    '\n',
  )
  assert.deepEqual(core.parseConverterOutput(noisy), { ok: true, engine: 'KWPP.Application', bytes: 42 })
})

await check('an unparsable or malformed result is a failure, not a silent success', () => {
  assert.equal(core.parseConverterOutput('').ok, false)
  assert.equal(core.parseConverterOutput('not json at all').ok, false)
  // `ok` without a boolean is not a verdict.
  assert.equal(core.parseConverterOutput('{"engine":"x"}').ok, false)
  const error = core.parseConverterOutput('{"ok":false,"error":"文档打开失败。"}')
  assert.equal(error.ok, false)
  assert.equal(error.error, '文档打开失败。')
})

await check('the queue runs one job at a time and survives a rejection', async () => {
  const queue = core.createQueue()
  let active = 0
  let peak = 0
  const order = []

  const job = id => async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    order.push(id)
  }

  await Promise.all([queue.run(job('a')), queue.run(job('b')), queue.run(job('c'))])
  assert.equal(peak, 1, 'two conversions ran at once — two COM suites can race on one document')
  assert.deepEqual(order, ['a', 'b', 'c'])
  assert.equal(queue.size(), 0)

  await assert.rejects(queue.run(async () => { throw new Error('boom') }))
  // The chain must still accept work; a rejected job must not deadlock it.
  await queue.run(job('d'))
  assert.deepEqual(order, ['a', 'b', 'c', 'd'])
})

await check('the interpreter is the override when given, else the first that exists', () => {
  const candidates = [
    { path: 'pwsh', exists: false },
    { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', exists: true },
  ]
  assert.equal(core.resolvePowerShell(candidates), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(core.resolvePowerShell(candidates, 'D:\\pwsh.exe'), 'D:\\pwsh.exe')
  assert.equal(core.resolvePowerShell([{ path: 'pwsh', exists: false }]), undefined)
})

await check('the converter receives paths as arguments, never as script literals', () => {
  const args = core.converterArgs('C:\\plug\\scripts\\convert-office.ps1', 'C:\\in\\简历.docx', 'C:\\out\\o.pdf', 'docx')
  assert.deepEqual(args.slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\plug\\scripts\\convert-office.ps1'])
  assert.deepEqual(args.slice(6), ['-Source', 'C:\\in\\简历.docx', '-Dest', 'C:\\out\\o.pdf', '-Kind', 'docx'])
  // Non-ASCII paths ride argv (UTF-16) precisely so they never meet the script's
  // own encoding, which Windows PowerShell 5.1 decodes as ANSI.
  assert.ok(args.includes('C:\\in\\简历.docx'))
  assert.deepEqual(core.probeArgs('x.ps1').slice(-1), ['-Probe'])
})

await check('a timeout is reported as a timeout, not as a converter error', async () => {
  const spawn = async () => ({ code: null, stdout: '', stderr: '', timedOut: true })
  const result = await core.convert(
    { powershell: 'p', scriptPath: 's', source: 'a', dest: 'b', kind: 'docx', timeoutMs: 5000 },
    spawn,
  )
  assert.equal(result.ok, false)
  assert.match(result.error, /timed out after 5s/)
})

await check('a converter failure keeps the engine\u2019s own words', async () => {
  const spawn = async () => ({ code: 1, stdout: '{"ok":false,"error":"KWPS.Application: 文档打开失败。"}', stderr: '', timedOut: false })
  const result = await core.convert(
    { powershell: 'p', scriptPath: 's', source: 'a', dest: 'b', kind: 'docx', timeoutMs: 5000 },
    spawn,
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'KWPS.Application: 文档打开失败。')
})

await check('a probe reports only the engines that answered', () => {
  const result = core.parseProbeOutput('{"ok":true,"engines":{"docx":"KWPS.Application","pptx":"KWPP.Application"}}')
  assert.deepEqual(result.kinds, ['docx', 'pptx'])
  assert.equal(result.engines.pptx, 'KWPP.Application')

  const partial = core.parseProbeOutput('{"ok":true,"engines":{"docx":"Word.Application"}}')
  assert.deepEqual(partial.kinds, ['docx'])
  assert.equal(core.parseProbeOutput('{"ok":true,"engines":{}}').kinds.length, 0)
  assert.equal(core.parseProbeOutput('garbage').kinds.length, 0)
})

await check('the cache key is content and kind, never a path', () => {
  const digest = bytes => `d${bytes.byteLength}`
  const a = new Uint8Array([1, 2, 3])
  const b = new Uint8Array([1, 2, 3])
  const c = new Uint8Array([1, 2, 3, 4])
  assert.equal(core.cacheKey(a, 'docx', digest), core.cacheKey(b, 'docx', digest))
  assert.notEqual(core.cacheKey(a, 'docx', digest), core.cacheKey(c, 'docx', digest))
  // Same bytes, different target format: a different artifact.
  assert.notEqual(core.cacheKey(a, 'docx', digest), core.cacheKey(a, 'pptx', digest))
})

await check('the sweep evicts by age first, then by count, and keeps the newest', () => {
  const now = 1_000_000_000
  const day = 24 * 60 * 60 * 1000
  const entries = [
    { name: 'ancient.pdf', mtimeMs: now - 10 * day, size: 1 },
    { name: 'new-1.pdf', mtimeMs: now - 1000, size: 1 },
    { name: 'new-2.pdf', mtimeMs: now - 2000, size: 1 },
    { name: 'new-3.pdf', mtimeMs: now - 3000, size: 1 },
  ]
  const evicted = core.filesToEvict(entries, now, 7 * day, 2)
  assert.ok(evicted.includes('ancient.pdf'), 'the aged entry must go')
  // maxCount 2 keeps the two newest, so the third-newest goes with the aged one.
  assert.deepEqual(evicted.sort(), ['ancient.pdf', 'new-3.pdf'])
  assert.equal(core.filesToEvict(entries.slice(1), now, 7 * day, 10).length, 0)
})

// ── the host half, driven through its real routes ────────────────────────────

// The bundle under test lives in a temp dir, so `../scripts/convert-office.ps1`
// is not beside it. Both paths are overridable precisely so this suite can drive
// the SHIPPED converter instead of a stand-in — an end-to-end test against a
// stub would prove nothing about the COM leg, which is the risky one.
const cacheRoot = mkdtempSync(join(tmpdir(), 'dsh-office-render-cache-'))
process.env.DSH_OFFICE_RENDER_SCRIPT = join(root, 'scripts', 'convert-office.ps1')
process.env.DSH_OFFICE_RENDER_CACHE = cacheRoot

const { routes } = mountHost()
const route = routes[0]

await check('apply registers exactly one prefix route under /office-render', () => {
  assert.equal(routes.length, 1)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/office-render')
})

await check('health answers with the engine inventory and never 500s', async () => {
  const result = await callRoute(route, { url: '/office-render/health', method: 'GET' })
  assert.equal(result.status, 200)
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8')
  const body = JSON.parse(result.body.toString('utf8'))
  assert.equal(body.ok, true)
  assert.equal(body.service, 'dsh-office-render')
  assert.equal(body.convertPath, '/office-render/convert')
  assert.ok(Array.isArray(body.kinds))
  assert.equal(typeof body.powershell, 'string')
  console.log(`      engines on this machine: ${JSON.stringify(body.engines)}`)
})

await check('unknown routes are 404 and a GET on convert is 405', async () => {
  const missing = await callRoute(route, { url: '/office-render/nope', method: 'GET' })
  assert.equal(missing.status, 404)
  const wrongMethod = await callRoute(route, { url: '/office-render/convert?ext=docx', method: 'GET' })
  assert.equal(wrongMethod.status, 405)
})

await check('a non-convertible extension is refused before any work', async () => {
  const result = await callRoute(route, { url: '/office-render/convert?ext=xlsx', method: 'POST', body: MINIMAL_DOCX })
  assert.equal(result.status, 415)
  assert.match(JSON.parse(result.body.toString('utf8')).error, /xlsx/)
})

await check('an empty body is refused', async () => {
  const result = await callRoute(route, { url: '/office-render/convert?ext=docx', method: 'POST', body: Buffer.alloc(0) })
  assert.equal(result.status, 400)
})

await check('a cross-origin POST cannot make this host launch Office', async () => {
  // The `ext=xlsx` choice keeps this from ever reaching the converter, so the
  // status alone says which guard fired first.
  const crossSite = await callRoute(route, {
    url: '/office-render/convert?ext=xlsx',
    method: 'POST',
    body: MINIMAL_DOCX,
    headers: { origin: 'http://evil.example', host: '127.0.0.1:5173' },
  })
  assert.equal(crossSite.status, 403)

  const sameOrigin = await callRoute(route, {
    url: '/office-render/convert?ext=xlsx',
    method: 'POST',
    body: MINIMAL_DOCX,
    headers: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' },
  })
  // Past the origin guard, stopped by the extension guard.
  assert.equal(sameOrigin.status, 415)

  // A header-less caller (the smoke script, curl) is allowed: it already needs
  // local access to the port.
  const noOrigin = await callRoute(route, {
    url: '/office-render/convert?ext=xlsx',
    method: 'POST',
    body: MINIMAL_DOCX,
    headers: { host: '127.0.0.1:5173' },
  })
  assert.equal(noOrigin.status, 415)
})

// The conversion leg only means something where an Office suite is installed.
const healthProbe = await callRoute(route, { url: '/office-render/health', method: 'GET' })
const available = JSON.parse(healthProbe.body.toString('utf8')).kinds ?? []

if (!available.includes('docx')) {
  skip(`end-to-end docx conversion (no docx engine here: ${JSON.stringify(available)})`)
} else {
  await check('end-to-end: a real .docx becomes a real PDF, then a cache hit', async () => {
    const first = await callRoute(route, {
      url: '/office-render/convert?ext=docx',
      method: 'POST',
      body: MINIMAL_DOCX,
    })
    assert.equal(first.status, 200, first.body.toString('utf8').slice(0, 400))
    assert.equal(first.headers['content-type'], 'application/pdf')
    assert.deepEqual([...first.body.subarray(0, 5)], [0x25, 0x50, 0x44, 0x46, 0x2d]) // %PDF-
    assert.ok(first.body.byteLength > 1000, `only ${first.body.byteLength} bytes`)
    assert.equal(first.headers['x-office-render-cache'], 'miss')
    assert.ok(typeof first.headers['x-office-render-engine'] === 'string')

    const second = await callRoute(route, {
      url: '/office-render/convert?ext=docx',
      method: 'POST',
      body: MINIMAL_DOCX,
    })
    assert.equal(second.status, 200)
    assert.equal(second.headers['x-office-render-cache'], 'hit')
    // Same document, same bytes.
    assert.equal(second.body.byteLength, first.body.byteLength)
  })
}

rmSync(outDir, { recursive: true, force: true })
rmSync(cacheRoot, { recursive: true, force: true })
console.log(`\ndsh-office-render :: ${checks} checks passed, 0 failed, ${skipped} skipped`)
