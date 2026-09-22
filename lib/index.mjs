// src/index.ts
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/host/render-core.ts
var KIND_BY_EXTENSION = {
  docx: "docx",
  docm: "docx",
  dotx: "docx",
  pptx: "pptx",
  pptm: "pptx",
  potx: "pptx"
};
function kindOfExtension(extension) {
  return KIND_BY_EXTENSION[extension.replace(/^\./, "").toLowerCase()];
}
function isConvertible(extension) {
  return kindOfExtension(extension) !== void 0;
}
function parseConverterOutput(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.ok !== "boolean") continue;
      return {
        ok: parsed.ok,
        ...typeof parsed.engine === "string" ? { engine: parsed.engine } : {},
        ...typeof parsed.bytes === "number" ? { bytes: parsed.bytes } : {},
        ...typeof parsed.error === "string" ? { error: parsed.error } : {}
      };
    } catch {
    }
  }
  return { ok: false, error: "converter produced no parsable result line" };
}
function cacheKey(payload, kind, digest) {
  return `${kind}-${digest(payload)}`;
}
function createQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    run(job) {
      pending++;
      const result = tail.then(job, job);
      tail = result.then(
        () => void 0,
        () => void 0
      );
      return result.finally(() => {
        pending--;
      });
    },
    size: () => pending
  };
}
function resolvePowerShell(candidates, override) {
  if (override !== void 0 && override.trim() !== "") return override.trim();
  return candidates.find((candidate) => candidate.exists)?.path;
}
function converterArgs(scriptPath, source, dest, kind) {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Source", source, "-Dest", dest, "-Kind", kind];
}
function probeArgs(scriptPath) {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Probe"];
}
async function convert(request, spawn2) {
  const outcome = await spawn2(
    request.powershell,
    converterArgs(request.scriptPath, request.source, request.dest, request.kind),
    { timeoutMs: request.timeoutMs }
  );
  if (outcome.timedOut) {
    return { ok: false, error: `conversion timed out after ${Math.round(request.timeoutMs / 1e3)}s` };
  }
  const reported = parseConverterOutput(outcome.stdout);
  if (reported.ok) return reported;
  const detail = reported.error ?? outcome.stderr.trim() ?? `converter exited with ${outcome.code}`;
  return { ok: false, error: detail };
}
function parseProbeOutput(stdout) {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.ok !== true) continue;
      const engines = {};
      for (const kind of ["docx", "pptx"]) {
        const engine = parsed.engines?.[kind];
        if (typeof engine === "string" && engine !== "") engines[kind] = engine;
      }
      return { kinds: ["docx", "pptx"].filter((kind) => engines[kind] !== void 0), engines };
    } catch {
    }
  }
  return { kinds: [], engines: {} };
}
function filesToEvict(entries, now, maxAgeMs, maxCount) {
  const doomed = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (now - entry.mtimeMs > maxAgeMs) doomed.add(entry.name);
  }
  const survivors = entries.filter((entry) => !doomed.has(entry.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of survivors.slice(maxCount)) doomed.add(entry.name);
  return [...doomed];
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// src/index.ts
var name = "dsh-office-render";
var inject = ["webServer"];
var BASE = "/office-render";
var MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
var CONVERT_TIMEOUT_MS = 12e4;
var PROBE_TIMEOUT_MS = 6e4;
var CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
var CACHE_MAX_COUNT = 200;
var queue = createQueue();
function spawnWithTimeout(file, args, options) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const killTree = () => {
      if (child.pid === void 0) return;
      try {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);
    const finish = (code, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: `${stderr}${extra}`, timedOut });
    };
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(null, `
${error.message}`));
    child.on("close", (code) => finish(code));
  });
}
function pluginRoot() {
  return dirname(fileURLToPath(import.meta.url));
}
function cacheDir() {
  return process.env.DSH_OFFICE_RENDER_CACHE ?? join(tmpdir(), "dsh-office-render");
}
function powershellPath() {
  const systemPowerShell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return resolvePowerShell(
    [
      { path: "pwsh", exists: false },
      { path: systemPowerShell, exists: existsSync(systemPowerShell) },
      { path: "powershell", exists: true }
    ],
    process.env.DSH_OFFICE_RENDER_POWERSHELL
  );
}
function converterScript() {
  const override = process.env.DSH_OFFICE_RENDER_SCRIPT;
  const script = override !== void 0 && override !== "" ? override : join(pluginRoot(), "..", "scripts", "convert-office.ps1");
  return existsSync(script) ? script : void 0;
}
function writeJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(payload.byteLength));
  response.setHeader("Cache-Control", "no-store");
  response.end(payload);
}
async function readBody(request, limit) {
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    request.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total > limit) {
        reject(new Error(`request body exceeds ${formatBytes(limit)}`));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", resolve);
    request.on("error", reject);
  });
  return new Uint8Array(Buffer.concat(chunks));
}
async function sweepCache() {
  const dir = cacheDir();
  try {
    const names = await readdir(dir);
    const entries = await Promise.all(
      names.map(async (entryName) => {
        const info = await stat(join(dir, entryName)).catch(() => void 0);
        return info === void 0 ? void 0 : { name: entryName, mtimeMs: info.mtimeMs, size: info.size };
      })
    );
    const present = entries.filter((entry) => entry !== void 0);
    for (const doomed of filesToEvict(present, Date.now(), CACHE_MAX_AGE_MS, CACHE_MAX_COUNT)) {
      await unlink(join(dir, doomed)).catch(() => void 0);
    }
  } catch {
  }
}
var swept = false;
async function sweepOnce() {
  if (swept) return;
  swept = true;
  await sweepCache();
}
var probeTask;
async function probe(refresh) {
  if (refresh) probeTask = void 0;
  if (probeTask === void 0) {
    probeTask = (async () => {
      const powershell = powershellPath();
      const script = converterScript();
      if (powershell === void 0 || script === void 0) return { kinds: [], engines: {} };
      const outcome = await queue.run(
        () => spawnWithTimeout(powershell, probeArgs(script), { timeoutMs: PROBE_TIMEOUT_MS })
      );
      if (outcome.timedOut) return { kinds: [], engines: {} };
      return parseProbeOutput(outcome.stdout);
    })();
  }
  const result = await probeTask;
  return { ...result, powershell: powershellPath() };
}
async function readMeta(path) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed.kind === "string" ? parsed : void 0;
  } catch {
    return void 0;
  }
}
async function convertBytes(payload, kind) {
  const powershell = powershellPath();
  const script = converterScript();
  if (powershell === void 0) return { ok: false, error: "no PowerShell interpreter found", status: 503 };
  if (script === void 0) {
    return { ok: false, error: "the converter script is missing from this installation", status: 503 };
  }
  await sweepOnce();
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  const key = cacheKey(payload, kind, (bytes) => createHash("sha256").update(bytes).digest("hex"));
  const outputPath = join(dir, `out-${key}.pdf`);
  const metaPath = join(dir, `meta-${key}.json`);
  const cached = await readFile(outputPath).catch(() => void 0);
  if (cached !== void 0 && cached.byteLength > 0) {
    const meta = await readMeta(metaPath);
    return {
      ok: true,
      pdf: new Uint8Array(cached),
      ...meta?.engine !== void 0 ? { engine: meta.engine } : {},
      cached: true
    };
  }
  const inputPath = join(dir, `in-${key}.${kind === "docx" ? "docx" : "pptx"}`);
  await writeFile(inputPath, payload);
  try {
    const request = {
      powershell,
      scriptPath: script,
      source: inputPath,
      dest: outputPath,
      kind,
      timeoutMs: CONVERT_TIMEOUT_MS
    };
    const result = await queue.run(() => convert(request, spawnWithTimeout));
    if (!result.ok) {
      return { ok: false, error: result.error ?? "conversion failed", status: 502 };
    }
    const pdf = await readFile(outputPath).catch(() => void 0);
    if (pdf === void 0 || pdf.byteLength === 0) {
      return { ok: false, error: "the converter reported success but wrote no output", status: 502 };
    }
    const meta = {
      ...result.engine !== void 0 ? { engine: result.engine } : {},
      kind,
      bytes: pdf.byteLength,
      createdAt: Date.now()
    };
    await writeFile(metaPath, JSON.stringify(meta)).catch(() => void 0);
    return { ok: true, pdf: new Uint8Array(pdf), ...result.engine !== void 0 ? { engine: result.engine } : {}, cached: false };
  } finally {
    await unlink(inputPath).catch(() => void 0);
  }
}
function headerOf(request, name2) {
  const direct = request.headers[name2] ?? request.headers[name2.toLowerCase()];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct) && direct.length > 0) return direct[0];
  return void 0;
}
function isSameOrigin(request) {
  const origin = headerOf(request, "origin");
  if (origin === void 0 || origin === "") return true;
  const host = headerOf(request, "host");
  if (host === void 0 || host === "") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
async function handle(request, response) {
  let url;
  try {
    url = new URL(request.url ?? "/", "http://dsh.internal");
  } catch {
    writeJson(response, 400, { ok: false, error: "malformed request URL" });
    return;
  }
  const route = url.pathname.slice(BASE.length);
  if (route === "/health") {
    const result2 = await probe(url.searchParams.get("refresh") === "1");
    writeJson(response, 200, {
      ok: true,
      service: name,
      version: "0.1.0",
      convertPath: `${BASE}/convert`,
      kinds: result2.kinds,
      engines: result2.engines,
      ...result2.powershell !== void 0 ? { powershell: result2.powershell } : {},
      ...converterScript() === void 0 ? { error: "converter script missing" } : {}
    });
    return;
  }
  if (route !== "/convert") {
    writeJson(response, 404, { ok: false, error: `unknown route ${url.pathname}` });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { ok: false, error: "use POST with the document bytes as the body" });
    return;
  }
  if (!isSameOrigin(request)) {
    writeJson(response, 403, { ok: false, error: "cross-origin conversion requests are refused" });
    return;
  }
  const extension = (url.searchParams.get("ext") ?? "").toLowerCase();
  if (!isConvertible(extension)) {
    writeJson(response, 415, { ok: false, error: `not a convertible extension: "${extension}"` });
    return;
  }
  const kind = kindOfExtension(extension);
  if (kind === void 0) {
    writeJson(response, 415, { ok: false, error: `not a convertible extension: "${extension}"` });
    return;
  }
  let payload;
  try {
    payload = await readBody(request, MAX_UPLOAD_BYTES);
  } catch (error) {
    writeJson(response, 413, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (payload.byteLength === 0) {
    writeJson(response, 400, { ok: false, error: "empty body" });
    return;
  }
  const result = await convertBytes(payload, kind);
  if (!result.ok) {
    console.warn(`[${name}] conversion failed (${kind}): ${result.error}`);
    writeJson(response, result.status, { ok: false, error: result.error });
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Length", String(result.pdf.byteLength));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Office-Render-Kind", kind);
  response.setHeader("X-Office-Render-Cache", result.cached ? "hit" : "miss");
  if (result.engine !== void 0) response.setHeader("X-Office-Render-Engine", result.engine);
  response.end(result.pdf);
}
function apply(rawCtx) {
  const ctx = rawCtx;
  if (ctx?.webServer === void 0) {
    console.warn(`[${name}] ctx.webServer is not available; faithful rendering stays off.`);
    return;
  }
  ctx.effect(
    () => ctx.webServer.register({
      kind: "prefix",
      path: BASE,
      handler: handle
    }),
    `${name}: ${BASE} routes`
  );
  console.log(`[${name}] mounted ${BASE}/health and ${BASE}/convert`);
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.mjs.map
