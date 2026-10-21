# NH Textures Optimizer

A static web page that losslessly optimises PNG textures in the browser. It takes a single PNG, several PNGs, a folder or a zip. Nothing is uploaded: [oxipng](https://github.com/oxipng/oxipng) runs as WebAssembly in a pool of web workers.

Settings are equivalent to `oxipng -o max --nc --ng --strip safe -z --fast` (oxipng 10.2.1):

- Pixels are never changed, and neither is the colour type. Java ImageIO, which Minecraft uses, decodes grayscale PNGs in a linear colour space, so converting RGB to grayscale would make the texture render brighter.
- Transparent pixels keep their RGB values (no `--alpha`), because mipmapping and filtering can bleed those colours.
- Only metadata that doesn't affect rendering is stripped. `iCCP`, `sRGB`, `pHYs` and animation chunks are kept.

## Results on GT5-Unofficial

Tested on 12,266 PNGs under `src/main/resources/assets`, which are already at optipng's fixpoint:

| Settings | Size | Saved |
| --- | --- | --- |
| original (`optipng -o7 -nc`) | 26.68 MB | 0% |
| oxipng, metadata kept | 26.00 MB | 2.5% |
| oxipng `--strip safe` | 23.10 MB | 13.4% |
| **oxipng `--strip safe -z` (this site)** | **22.88 MB** | **14.2%** |
| oxipng `--strip all -z` | 21.35 MB | 20.0% |
| oxipng `--ng --strip safe -z` (allows palette) | 22.57 MB | 15.4% |

- Most of the gain comes from metadata: XMP `iTXt` (2.2 MB), `eXIf`, `zTXt`, `tEXt`, `gAMA` and so on.
- Results are verified pixel-identical with Pillow, and identical in Java ImageIO `getRGB` (what `TextureUtil` uses) for both `--strip safe` and `--strip all`.
- Three files (`tectech/models/StarLayer0/2.png`, `spaceLayer.png`) are actually JPEGs. They are reported and left untouched.

## CI and CLI

A CI check only stays consistent with the site if it runs **the same optimiser**. Each configuration is a fixpoint of itself, but not of the others:

- `optipng -o7 -nc` still shaves bytes off 263 of the site's outputs.
- oxipng without `-z` changes 1,440 of them.
- Even native oxipng with identical settings isn't byte-identical to the wasm build. The wasm output is never larger, and smaller on 920 files. Native oxipng 10.2.1 with the same settings did leave every wasm output unchanged, so a native CI (about 6× faster) also works in practice, just not by construction.

`site/cli.mjs` runs the site's wasm under Node:

- `node cli.mjs <files|dirs>` optimises in place.
- `node cli.mjs --check ...` lists files that would change and exits 1 if there are any.

`ci/optimize-images.yml` is a proposed replacement for the org workflow. It fetches `cli.mjs` and `pkg/` from the deployed site, so CI and site can't drift apart. It also fails fork PRs with a pointer to the site instead of trying to push to them.

## Build

Requirements: Rust with the `wasm32-unknown-unknown` target, `wasm-pack`, and clang (libdeflate is C).

```sh
cd wasm
CC_wasm32_unknown_unknown=clang AR_wasm32_unknown_unknown=llvm-ar \
  wasm-pack build --release --target web --no-pack --out-dir ../site/pkg --out-name nh_png
```

On Windows with the GNU Rust toolchain, a MinGW `bin` (for `dlltool`/`as`) and LLVM's `bin` need to be on `PATH`.

`wasm/Cargo.lock` pins `libdeflater`, `libdeflate-sys` and `zopfli` to the versions in oxipng 10.2.1's own lockfile. Any change to the wasm (versions or settings) can make CI flag files optimised with the previous build, but only files touched by a PR are checked.

Then serve `site/` with any static server, for example `python -m http.server --directory site`. `.github/workflows/pages.yml` builds the site and deploys it to GitHub Pages.
