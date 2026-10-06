# Third-party notices

The offline HTML files contain third-party runtimes. Their licenses and upstream source links are also available through **About → Decoder license** and **About → Database license**.

- **wa-sqlite**, commit `96d91182bf958d1c9fce2d851f66198378d8dbf1`: MIT. See `vendor/wa-sqlite/LICENSE` and [upstream source](https://github.com/rhashimoto/wa-sqlite/tree/96d91182bf958d1c9fce2d851f66198378d8dbf1).
- **@ffmpeg/core 0.12.10**, the single-thread FFmpeg WebAssembly core: GPL-2.0-or-later. See `vendor/ffmpeg-core/COPYING`, its README, and [FFmpeg source](https://github.com/FFmpeg/FFmpeg/tree/n5.1.4). The JavaScript wrapper's MIT notice is in `vendor/ffmpeg-core/LICENSE`; [wrapper source and build scripts](https://github.com/ffmpegwasm/ffmpeg.wasm) describe the bundled codec libraries.
- **libheif-js 1.23.5**, libheif and libde265: LGPL-3.0. The HTML includes the license text. Source: [libheif-js](https://github.com/catdad-experiments/libheif-js), [libheif](https://github.com/strukturag/libheif), and [libde265](https://github.com/strukturag/libde265).
- **@noble/hashes 2.0.0**: MIT. Used by the embedded fingerprinting worker. See `vendor/noble-hashes/LICENSE` and [upstream source](https://github.com/paulmillr/noble-hashes/tree/2.0.0).
- **SQLite**: public domain. See [SQLite's copyright notice](https://sqlite.org/copyright.html).

The embedded HEIF and video-decoder WASM memory maxima are capped at 256 MiB per decoder. The video build script applies its memory cap and gzip encoding reproducibly to the retained upstream WASM bytes.
