import init, { optimize } from './pkg/nh_png.js';

const ready = init();

onmessage = async ({ data: { id, bytes, level, zopfli } }) => {
  await ready;
  try {
    const out = optimize(new Uint8Array(bytes), level, zopfli);
    postMessage({ id, out }, [out.buffer]);
  } catch (e) {
    // A wasm trap (panic) leaves the instance unusable, so ask to be replaced.
    postMessage({ id, error: String(e?.message ?? e), dead: e instanceof WebAssembly.RuntimeError });
  }
};
