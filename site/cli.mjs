// Same optimiser as the web page, for CI and local use (Node 18+).
// Usage: node cli.mjs [--check] <file.png|dir>...
//   default  optimise PNGs in place
//   --check  write nothing, list PNGs that would change and exit 1 if any
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LEVEL = 6;
const ZOPFLI = true;
const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pkg');

if (isMainThread) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const files = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) if (e !== '.git') walk(path.join(p, e));
    } else if (/\.png$/i.test(p)) {
      files.push(p);
    }
  };
  args.filter((a) => a !== '--check').forEach(walk);

  let next = 0, done = 0, before = 0, after = 0;
  const changed = [], failed = [];
  const finish = () => {
    const verb = check ? 'would change' : 'optimised';
    console.log(`${files.length} PNGs, ${changed.length} ${verb}, ${before - after} bytes saved`);
    for (const f of failed) console.error(`warning: ${f}`);
    if (check && changed.length) {
      console.log(changed.join('\n'));
      process.exitCode = 1;
    }
  };
  if (!files.length) finish();

  const workers = Math.min(files.length, os.availableParallelism?.() ?? os.cpus().length);
  for (let i = 0; i < workers; i++) {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { pkg } });
    const feed = () => {
      if (next >= files.length) return void w.terminate();
      const file = files[next++];
      w.postMessage({ file, bytes: fs.readFileSync(file) });
    };
    w.on('message', ({ file, size, out, error }) => {
      before += size;
      if (error) {
        failed.push(`${file}: ${error}`);
        after += size;
      } else if (out.length < size) {
        changed.push(file);
        after += out.length;
        if (!check) fs.writeFileSync(file, out);
      } else {
        after += size;
      }
      if (++done === files.length) finish();
      feed();
    });
    feed();
  }
} else {
  const mod = await import(pathToFileURL(path.join(workerData.pkg, 'nh_png.js')));
  mod.initSync({ module: fs.readFileSync(path.join(workerData.pkg, 'nh_png_bg.wasm')) });
  parentPort.on('message', ({ file, bytes }) => {
    try {
      parentPort.postMessage({ file, size: bytes.length, out: mod.optimize(bytes, LEVEL, ZOPFLI) });
    } catch (e) {
      parentPort.postMessage({ file, size: bytes.length, error: String(e?.message ?? e) });
    }
  });
}
