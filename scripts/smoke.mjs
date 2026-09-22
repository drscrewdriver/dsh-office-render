/**
 * Smoke test for the built artifact, over real HTTP.
 *
 * `npm test` drives the host half from source. This drives `lib/index.mjs` —
 * the file that actually ships — through a real `node:http` server, so it also
 * covers the parts a fake req/res cannot: Node's request lifecycle, real body
 * streaming, and response framing.
 *
 * It is the fastest way to answer "does conversion work on this machine?"
 * without restarting DSH:
 *
 *   npm run build && npm run smoke
 *   npm run smoke -- "C:\path\to\deck.pptx"      # a specific file
 *   npm run smoke -- "C:\path\to\resume.docx"
 *
 * Exit code 0 means every step passed. With no file argument it uses a tiny
 * .docx generated in-process, so the default run depends on nothing outside this
 * repository.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// ── a tiny .docx, so the default run needs no external file ──────────────────

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

function zip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.data, 'utf8')
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
  return Buffer.concat([...locals, directory, eocd])
}

function minimalDocx() {
  return zip([
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
  <w:body><w:p><w:r><w:t>office-render smoke</w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>`,
    },
  ])
}

// ── mount the built host half on a real server ───────────────────────────────

const host = await import(pathToFileURL(join(root, 'lib', 'index.mjs')).href)

const server = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0]
  const route = registered.find(candidate =>
    candidate.kind === 'prefix' ? path.startsWith(candidate.path) : path === candidate.path,
  )
  if (route === undefined) {
    response.statusCode = 404
    response.end('no route')
    return
  }
  void Promise.resolve(route.handler(request, response)).catch(error => {
    response.statusCode = 500
    response.end(String(error))
  })
})

const registered = []
host.apply({
  effect(factory) {
    factory()
  },
  webServer: {
    register(route) {
      registered.push(route)
      return () => {}
    },
  },
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

let failures = 0
const step = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok ' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures++
}

try {
  console.log(`dsh-office-render :: smoke against ${base}`)

  const healthResponse = await fetch(`${base}/office-render/health`)
  const health = await healthResponse.json()
  step('health responds 200', healthResponse.status === 200)
  step('health reports a converter path', typeof health.convertPath === 'string', health.convertPath)
  step('health names the interpreter', typeof health.powershell === 'string', health.powershell ?? '')
  step(
    'at least one engine answered',
    Array.isArray(health.kinds) && health.kinds.length > 0,
    JSON.stringify(health.engines ?? {}),
  )

  const explicit = process.argv[2]
  const targets = explicit !== undefined && explicit !== '' ? [explicit] : ['<generated>.docx']

  for (const target of targets) {
    const generated = target === '<generated>.docx'
    const extension = extname(generated ? 'x.docx' : target).replace('.', '').toLowerCase()
    const bytes = generated ? minimalDocx() : readFileSync(target)
    const started = Date.now()
    const response = await fetch(`${base}/office-render/convert?ext=${extension}`, {
      method: 'POST',
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    const elapsed = Date.now() - started

    if (response.status !== 200) {
      step(`convert ${target}`, false, `${response.status} ${await response.text()}`)
      continue
    }
    const pdf = Buffer.from(await response.arrayBuffer())
    step(`convert ${target}`, true, `${pdf.length} bytes in ${elapsed}ms, engine ${response.headers.get('x-office-render-engine')}`)
    step(`  ${target} is a PDF`, pdf.subarray(0, 5).toString('latin1') === '%PDF-')
    step(`  ${target} is not empty`, pdf.length > 1000)
  }
} finally {
  await new Promise(resolve => server.close(resolve))
}

console.log('')
if (failures === 0) {
  console.log('smoke: all steps passed')
  process.exit(0)
}
console.log(`smoke: ${failures} step(s) failed`)
process.exit(1)
