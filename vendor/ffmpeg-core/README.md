@ffmpeg/core 0.12.10 is the single-thread FFmpeg WebAssembly decoder used to capture video posters when browser decoding fails. Upstream package: https://registry.npmjs.org/@ffmpeg/core/-/core-0.12.10.tgz.

The package's FFmpeg core is GPL-2.0-or-later; see COPYING. The JavaScript wrapper's MIT notice is in LICENSE. FFmpeg source is at https://github.com/FFmpeg/FFmpeg/tree/n5.1.4 and build scripts are at https://github.com/ffmpegwasm/ffmpeg.wasm. The upstream distribution includes third-party codec libraries; see https://ffmpegwasm.netlify.app/docs/overview/.

scripts/build-media-preview.cjs embeds the JavaScript and gzip-compressed WASM directly in the HTML. It changes only the WASM memory maximum to 256 MiB; the files under dist retain the upstream bytes. Run this script or scripts/assemble-media-reviewer.cjs to reproduce the embedded build.

The decoder runs in a dedicated worker and reads selected videos through WORKERFS, which supports seeking without copying an entire video into its memory filesystem. It writes one scaled frame, then removes the temporary output and unmounts the original. Captured posters are re-encoded by the browser and stored in SQLite.
