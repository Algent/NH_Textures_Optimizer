import { unzip, zip } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';

// Must match the CI check (cli.mjs, same wasm): outputs of different
// settings are not fixpoints of each other, so any mismatch makes CI rewrite files.
const LEVEL = 6;
const ZOPFLI = true;
const $ = (s) => document.querySelector(s);

class Pool {
  constructor(size) {
    this.idle = [];
    this.queue = [];
    this.jobs = new Map();
    this.nextId = 0;
    for (let i = 0; i < size; i++) this.spawn();
  }

  spawn() {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    const replace = () => {
      w.terminate();
      this.spawn();
    };
    w.onmessage = ({ data }) => {
      const job = this.jobs.get(data.id);
      this.jobs.delete(data.id);
      w.job = null;
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.out);
      if (data.dead) replace();
      else this.release(w);
    };
    // Uncaught worker failures (e.g. out of memory) never reach onmessage.
    w.onerror = (e) => {
      e.preventDefault();
      const job = w.job && this.jobs.get(w.job);
      if (job) {
        this.jobs.delete(w.job);
        job.reject(new Error(e.message || 'Worker crashed'));
      }
      replace();
    };
    this.release(w);
  }

  release(w) {
    const next = this.queue.shift();
    if (next) this.dispatch(w, next);
    else this.idle.push(w);
  }

  dispatch(w, job) {
    this.jobs.set(job.id, job);
    w.job = job.id;
    w.postMessage({ id: job.id, bytes: job.bytes, level: LEVEL, zopfli: ZOPFLI }, [job.bytes.buffer]);
  }

  run(bytes) {
    return new Promise((resolve, reject) => {
      const job = { id: this.nextId++, bytes: bytes.slice(), resolve, reject };
      const w = this.idle.pop();
      if (w) this.dispatch(w, job);
      else this.queue.push(job);
    });
  }
}

const pool = new Pool(Math.max(1, (navigator.hardwareConcurrency || 4) - 1));

const isPng = (p) => /\.png$/i.test(p) && !p.startsWith('__MACOSX/');
const fmt = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const pct = (a, b) => (a ? `${(((a - b) / a) * 100).toFixed(1)}%` : '0%');
const unzipAsync = (data) => new Promise((res, rej) => unzip(data, (e, r) => (e ? rej(e) : res(r))));
const zipAsync = (files) => new Promise((res, rej) => zip(files, (e, r) => (e ? rej(e) : res(r))));
const readBytes = async (file) => new Uint8Array(await file.arrayBuffer());

// Collects dropped/picked items into { name, entries: Map<path, Uint8Array>, single }.
async function collect(files) {
  if (files.length === 1 && /\.zip$/i.test(files[0].path)) {
    const f = files[0];
    const entries = new Map(Object.entries(await unzipAsync(await readBytes(f.file))).filter(([p]) => !p.endsWith('/')));
    return { name: f.path.replace(/\.zip$/i, ''), entries, single: false };
  }
  const entries = new Map();
  for (const f of files) entries.set(f.path, await readBytes(f.file));
  if (files.length === 1 && isPng(files[0].path)) {
    return { name: files[0].path.split('/').pop(), entries, single: true };
  }
  const roots = new Set(files.map((f) => f.path.split('/')[0]));
  const name = roots.size === 1 && files[0].path.includes('/') ? [...roots][0] : 'textures';
  return { name, entries, single: false };
}

async function walkEntry(entry, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: entry.fullPath.replace(/^\//, ''), file });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walkEntry(e, out);
    }
  }
}

let busy = false;

async function process(files) {
  if (busy || !files.length) return;
  busy = true;
  $('#result').hidden = true;
  $('#status').hidden = false;
  $('#bar').value = 0;
  $('#progress').textContent = 'Reading files…';

  try {
    const job = await collect(files);
    const pngs = [...job.entries.keys()].filter(isPng);
    if (!pngs.length) throw new Error('No PNG files found.');

    let done = 0, before = 0, after = 0;
    const rows = [], failed = [];
    const started = performance.now();
    const tick = () => {
      $('#bar').value = done / pngs.length;
      $('#progress').textContent = `${done} / ${pngs.length} PNGs · ${fmt(before - after)} saved so far`;
    };
    tick();

    await Promise.all(pngs.map(async (path) => {
      const input = job.entries.get(path);
      try {
        const out = await pool.run(input);
        if (out.length < input.length) job.entries.set(path, out);
        rows.push({ path, a: input.length, b: Math.min(out.length, input.length) });
      } catch (e) {
        failed.push({ path, error: e.message });
        rows.push({ path, a: input.length, b: input.length });
      }
      before += input.length;
      after += job.entries.get(path).length;
      done++;
      tick();
    }));

    $('#progress').textContent = 'Packing…';
    let blob, filename;
    if (job.single) {
      blob = new Blob([job.entries.get(pngs[0])], { type: 'image/png' });
      filename = job.name;
    } else {
      const files = {};
      for (const [p, d] of job.entries) files[p] = isPng(p) ? [d, { level: 0 }] : d;
      blob = new Blob([await zipAsync(files)], { type: 'application/zip' });
      filename = `${job.name}-optimized.zip`;
    }
    showResult({ blob, filename, rows, failed, before, after, secs: (performance.now() - started) / 1000 });
  } catch (e) {
    $('#progress').textContent = `Error: ${e.message}`;
    busy = false;
    return;
  }
  $('#status').hidden = true;
  busy = false;
}

function showResult({ blob, filename, rows, failed, before, after, secs }) {
  const changed = rows.filter((r) => r.b < r.a).sort((x, y) => (y.a - y.b) - (x.a - x.b));
  $('#summary').textContent =
    `${rows.length} PNG${rows.length === 1 ? '' : 's'}, ${changed.length} smaller · ${fmt(before)} → ${fmt(after)} (${pct(before, after)} saved) · ${secs.toFixed(1)}s`;
  const link = $('#download');
  URL.revokeObjectURL(link.href);
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.textContent = `Download ${filename}`;

  $('#failed').hidden = !failed.length;
  $('#failed-list').replaceChildren(...failed.map((f) => li(`${f.path}: ${f.error}`)));
  $('#failed-count').textContent = failed.length;

  const shown = changed.slice(0, 200);
  $('#rows').replaceChildren(...shown.map((r) => {
    const tr = document.createElement('tr');
    for (const v of [r.path, fmt(r.a), fmt(r.b), pct(r.a, r.b)]) tr.append(Object.assign(document.createElement('td'), { textContent: v }));
    return tr;
  }));
  $('#more').textContent = changed.length > shown.length ? `…and ${changed.length - shown.length} more` : '';
  $('#table').hidden = !changed.length;
  $('#result').hidden = false;
}

const li = (text) => Object.assign(document.createElement('li'), { textContent: text });

const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const out = [];
  for (const entry of [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).filter(Boolean)) await walkEntry(entry, out);
  process(out);
});
for (const id of ['#pick-files', '#pick-folder']) {
  $(id).addEventListener('change', (e) => {
    process([...e.target.files].map((file) => ({ path: file.webkitRelativePath || file.name, file })));
    e.target.value = '';
  });
}
