#!/usr/bin/env node
// Diagnóstico SolaX — lectura local del Pocket WiFi (X3-MIC/PRO G2, tipo 16)
// Uso: node server.js  (la IP y la contraseña se introducen en la interfaz)
// Opcional: --ip 192.168.18.144 --pwd NUMERO_DE_REGISTRO --interval 3000 --port 8080 --mock
// Requiere Node 18 o superior. Sin dependencias.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Configuración ----------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.env[`SOLAX_${name.toUpperCase()}`] ?? fallback;
}

// config.json solo existe si marcas «Recordar en este equipo»
// Valores con los que se rellena el formulario de conexión
const DEFAULTS = { ip: '192.168.18.144', pwd: 'SRJESHHEJJ' };

const CONFIG_FILE = path.join(__dirname, 'config.json');
let saved = {};
try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* sin fichero */ }

const CFG = {
  ip: arg('ip', saved.ip || ''),
  pwd: arg('pwd', saved.pwd || ''),
  interval: Math.max(1000, Number(arg('interval', saved.interval || 3000))),
  port: Number(arg('port', 8080)),
  timeout: 5000,
  mock: process.argv.includes('--mock'),
  historyMinutes: 24 * 60, // lo que se guarda en memoria para la gráfica
};
const isConfigured = () => CFG.mock || Boolean(CFG.ip && CFG.pwd);

// ---------- Decodificación tipo 16 (X3-MIC/PRO G2) ----------
// Mapa: github.com/nazar-pc/solax-local-api-docs (Data2.txt, bloque 16)
const s16 = (n) => (n >= 32768 ? n - 65536 : n);
const u32 = (lo, hi) => lo + 65536 * hi;
const s32 = (lo, hi) => (hi >= 32768 ? lo + 65536 * hi - 4294967296 : lo + 65536 * hi);

// Códigos de estado habituales de SolaX (no vienen en Data2.txt; se muestra el número por si acaso)
const RUN_MODES = ['Esperando', 'Comprobando', 'Normal', 'Fallo', 'Fallo permanente',
  'Actualizando', 'Comprobación EPS', 'EPS', 'Autotest', 'Inactivo', 'Standby'];

function decode(json) {
  const d = json.Data;
  if (!Array.isArray(d) || d.length < 80) throw new Error('El dongle respondió sin datos válidos');
  if (json.type !== 16) throw new Error(`Tipo de inversor ${json.type}: esta app solo sabe leer el tipo 16 (X3-MIC/PRO G2)`);

  const phases = [0, 1, 2].map((i) => ({
    v: d[i] / 10,
    a: s16(d[3 + i]) / 10,
    w: s16(d[6 + i]),
    hz: d[18 + i] / 100,
  }));
  const dc = [0, 1, 2].map((i) => ({ v: d[9 + i] / 10, a: d[12 + i] / 10, w: d[15 + i] }))
    .filter((s) => s.v > 0 || s.w > 0);

  const acPower = phases.reduce((t, p) => t + p.w, 0);
  const dcPower = dc.reduce((t, s) => t + s.w, 0);
  const grid = s32(d[72], d[73]); // + exporta, − importa
  const load = acPower - grid;    // sin batería: consumo = producción AC − red

  return {
    t: Date.now(),
    acPower, dcPower, grid, load,
    phases, dc,
    runMode: `${RUN_MODES[d[21]] ?? 'Desconocido'} (${d[21]})`,
    yieldToday: d[24] / 10,
    yieldTotal: u32(d[22], d[23]) / 10,
    meterExportTotal: u32(d[74], d[75]) / 100,
    meterImportTotal: u32(d[76], d[77]) / 100,
    raw: d,
    sn: json.sn, ver: json.ver, type: json.type,
    inverterSn: json.Information?.[2],
  };
}

// ---------- Lectura del dongle ----------
async function readDongle(ip = CFG.ip, pwd = CFG.pwd) {
  let res;
  try {
    res = await fetch(`http://${ip}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `optType=ReadRealTimeData&pwd=${encodeURIComponent(pwd)}`,
      signal: AbortSignal.timeout(CFG.timeout),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`El dongle en ${ip} no responde (timeout)`);
    throw new Error(`No se puede conectar con ${ip}. Comprueba la IP y que estás en la misma red`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`El dongle respondió con HTTP ${res.status}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Respuesta inesperada del dongle («${text.slice(0, 40)}»). Comprueba la contraseña`); }
}

// Simulador para probar la interfaz sin el inversor
const mock = { load: 250, nextToggle: Date.now() + 20000, invert: false };
function mockDongle() {
  const now = Date.now();
  if (now > mock.nextToggle) {
    mock.load = mock.load > 1000 ? 250 : 250 + 1800;
    mock.invert = Math.random() < 0.3;
    mock.nextToggle = now + 15000 + Math.random() * 20000;
  }
  const ac = Math.round(3000 + Math.sin(now / 60000) * 400 + Math.random() * 60);
  let grid = ac - Math.round(mock.load + Math.random() * 40);
  if (mock.invert && mock.load > 1000) grid = ac + (mock.load - 250); // simula signo invertido
  const g = grid < 0 ? grid + 4294967296 : grid;
  const d = new Array(100).fill(0);
  [2408, 2370, 2393].forEach((v, i) => (d[i] = v));
  [0, 1, 2].forEach((i) => { d[6 + i] = Math.round(ac / 3); d[3 + i] = Math.round(ac / 3 / 24); d[18 + i] = 4998; });
  d[9] = 3577; d[10] = 1716; d[12] = 50; d[13] = 50;
  d[15] = Math.round(ac * 0.63); d[16] = Math.round(ac * 0.4);
  d[21] = 2; d[22] = 9462; d[24] = 70;
  d[72] = g % 65536; d[73] = Math.floor(g / 65536);
  d[74] = 29461; d[76] = 21911; d[78] = ac;
  return { sn: 'MOCK000000', ver: 'mock', type: 16, Data: d, Information: [8, 16, 'MOCK-INV'] };
}

// ---------- Registro CSV ----------
fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logPath = path.join(__dirname, 'logs', `solax-${stamp}.csv`);
const log = fs.createWriteStream(logPath, { flags: 'a' });
log.write('hora,evento,produccion_ac_w,produccion_dc_w,red_w,consumo_w,' +
  'fase1_w,fase2_w,fase3_w,fase1_v,fase2_v,fase3_v,estado,produccion_hoy_kwh,contador_export_kwh,contador_import_kwh,nota\n');

const csvTime = (t) => new Date(t).toLocaleString('sv-SE').replace(' ', 'T');
const csvText = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;

function logSample(s) {
  log.write([csvTime(s.t), 'lectura', s.acPower, s.dcPower, s.grid, s.load,
    ...s.phases.map((p) => p.w), ...s.phases.map((p) => p.v), csvText(s.runMode),
    s.yieldToday, s.meterExportTotal, s.meterImportTotal, ''].join(',') + '\n');
}
function logEvent(t, kind, note) {
  log.write([csvTime(t), kind, '', '', '', '', '', '', '', '', '', '', '', '', '', '', csvText(note)].join(',') + '\n');
}

// ---------- Estado y difusión (SSE) ----------
const history = [];   // solo lo que necesita la gráfica
const marks = [];
let lastSample = null; // última lectura completa (fases, strings, contadores…)
const point = (s) => ({ t: s.t, acPower: s.acPower, dcPower: s.dcPower, grid: s.grid, load: s.load });
const clients = new Set();
const status = { ok: false, error: null, lastOk: null, latency: null, unchangedSince: null, failures: 0 };
let lastRawKey = null;

const publicConfig = () => ({ ip: CFG.ip, interval: CFG.interval, hasPwd: Boolean(CFG.pwd), configured: isConfigured(), mock: CFG.mock, defaults: DEFAULTS });
const publicStatus = () => ({ ...status, interval: CFG.interval, configured: isConfigured() });

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function trimHistory() {
  const cutoff = Date.now() - CFG.historyMinutes * 60000;
  while (history.length && history[0].t < cutoff) history.shift();
  while (marks.length && marks[0].t < cutoff) marks.shift();
}

async function poll() {
  const started = Date.now();
  if (!isConfigured()) {
    Object.assign(status, { ok: false, error: 'Falta configurar la conexión con el dongle' });
    broadcast('status', publicStatus());
    return setTimeout(poll, 1000);
  }
  try {
    const json = CFG.mock ? mockDongle() : await readDongle();
    const sample = decode(json);
    const key = sample.raw.join(',');
    status.unchangedSince = key === lastRawKey ? (status.unchangedSince ?? started) : null;
    lastRawKey = key;

    Object.assign(status, { ok: true, error: null, lastOk: sample.t, latency: Date.now() - started, failures: 0 });
    lastSample = sample;
    history.push(point(sample));
    trimHistory();
    logSample(sample);
    broadcast('sample', sample);
  } catch (err) {
    status.failures += 1;
    Object.assign(status, { ok: false, error: err.message });
  }
  broadcast('status', publicStatus());

  // Si falla, espera más para no saturar el dongle
  const wait = status.ok ? CFG.interval : Math.min(30000, CFG.interval * 2 ** Math.min(status.failures, 4));
  setTimeout(poll, Math.max(0, wait - (Date.now() - started)));
}

// ---------- Lectura de los CSV de logs/ ----------
// Devuelve lecturas y marcas entre from y to (ms). Lo usan el arranque (últimas 24 h)
// y el filtro de rango de fechas de la gráfica.
function readLogs(from, to, { skipCurrent = false } = {}) {
  const dir = path.join(__dirname, 'logs');
  const points = [], found = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).sort()) {
    const full = path.join(dir, f);
    if (skipCurrent && full === logPath) continue;
    if (fs.statSync(full).mtimeMs < from) continue; // el fichero terminó antes del rango
    for (const line of fs.readFileSync(full, 'utf8').split('\n').slice(1)) {
      if (!line) continue;
      const cols = line.split(',');
      const t = new Date(cols[0]).getTime();
      if (!(t >= from && t <= to)) continue;
      if (cols[1] === 'lectura') {
        const p = { t, acPower: +cols[2], dcPower: +cols[3], grid: +cols[4], load: +cols[5] };
        if ([p.acPower, p.grid, p.load].every(Number.isFinite)) points.push(p);
      } else if (cols[1] === 'marca' || cols[1] === 'prueba') {
        const note = cols.slice(16).join(',').replace(/^"|"$/g, '').replace(/""/g, '"');
        found.push({ t, label: note, kind: cols[1] });
      }
    }
  }
  points.sort((a, b) => a.t - b.t);
  found.sort((a, b) => a.t - b.t);
  return { points, marks: found };
}

// Reduce muchas lecturas a ~maxBuckets tramos conservando el mínimo y el máximo de cada serie,
// para que los picos cortos sigan apareciendo en rangos largos.
function decimate(points, from, to, maxBuckets = 3000) {
  if (points.length <= maxBuckets * 2) return { points, bucketMs: 0 };
  const bucketMs = Math.ceil((to - from) / maxBuckets);
  const keys = ['acPower', 'dcPower', 'grid', 'load'];
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const lo = { t: cur.t0 }, hi = { t: cur.t0 + bucketMs / 2 };
    for (const k of keys) { lo[k] = cur.min[k]; hi[k] = cur.max[k]; }
    out.push(lo, hi);
  };
  for (const p of points) {
    const b = Math.floor((p.t - from) / bucketMs);
    if (!cur || cur.b !== b) {
      flush();
      cur = { b, t0: from + b * bucketMs, min: { ...p }, max: { ...p } };
      continue;
    }
    for (const k of keys) {
      if (p[k] < cur.min[k]) cur.min[k] = p[k];
      if (p[k] > cur.max[k]) cur.max[k] = p[k];
    }
  }
  flush();
  return { points: out, bucketMs };
}

// Al reiniciar, la gráfica vuelve a mostrar las últimas 24 h a partir de los CSV.
{
  const now = Date.now();
  const prev = readLogs(now - CFG.historyMinutes * 60000, now, { skipCurrent: true });
  history.push(...prev.points);
  marks.push(...prev.marks);
  if (history.length) console.log(`Recuperadas ${history.length} lecturas de sesiones anteriores`);
}

// ---------- Servidor HTTP ----------
async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'public', 'index.html')).pipe(res);
  }

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: init\ndata: ${JSON.stringify({ history, marks, last: lastSample, status: publicStatus(), config: publicConfig(), logPath })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/range') {
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return sendJson(res, 400, { error: 'Rango de fechas no válido' });
    }
    const { points, marks: rangeMarks } = readLogs(from, to);
    const reduced = decimate(points, from, to);
    return sendJson(res, 200, { from, to, total: points.length, ...reduced, marks: rangeMarks });
  }

  if (url.pathname === '/config' && req.method === 'POST') {
    const data = await readJson(req);
    const ip = String(data.ip || '').trim();
    const pwd = String(data.pwd || '').trim() || CFG.pwd; // vacía = mantener la actual
    const interval = Math.max(1000, Number(data.interval) || CFG.interval);

    if (!CFG.mock && !/^[a-zA-Z0-9.-]+(:\d+)?$/.test(ip)) return sendJson(res, 400, { ok: false, error: 'La IP no es válida' });
    if (!CFG.mock && !pwd) return sendJson(res, 400, { ok: false, error: 'Falta la contraseña (número de registro del dongle)' });

    // Prueba la conexión antes de aplicar nada
    try {
      decode(CFG.mock ? mockDongle() : await readDongle(ip, pwd));
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }

    Object.assign(CFG, { ip, pwd, interval });
    lastRawKey = null;
    status.failures = 0;
    if (data.remember) fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ip, pwd, interval }, null, 2));
    else fs.rmSync(CONFIG_FILE, { force: true });

    logEvent(Date.now(), 'config', `Conectado a ${ip || 'simulador'}, cada ${interval / 1000} s`);
    broadcast('config', publicConfig());
    return sendJson(res, 200, { ok: true, config: publicConfig() });
  }

  if (url.pathname === '/mark' && req.method === 'POST') {
    const data = await readJson(req);
    const mark = { t: Date.now(), label: String(data.label || 'Marca').slice(0, 120), kind: data.kind || 'marca' };
    marks.push(mark);
    logEvent(mark.t, mark.kind, mark.label);
    broadcast('mark', mark);
    return sendJson(res, 200, mark);
  }

  res.writeHead(404).end('No encontrado');
});

server.listen(CFG.port, () => {
  console.log(`Diagnóstico SolaX en http://localhost:${CFG.port}`);
  if (CFG.mock) console.log('Modo simulación (sin inversor)');
  else if (isConfigured()) console.log(`Leyendo ${CFG.ip} cada ${CFG.interval / 1000} s`);
  else console.log('Abre la página para introducir la IP y la contraseña del dongle');
  console.log(`Registro: ${logPath}`);
  poll();
});

process.on('SIGINT', () => {
  log.end(() => process.exit(0));
});
