# Changelog

## 3.2.1 — October 6, 2026

- Raised the estimated database size limit for adding Evidence originals to 2.5 GB by default.
- Added a 5 GB option under Maintenance, saved with each database. Normal scans can continue beyond this threshold while browser storage is available.

## 3.2.0 — October 6, 2026

- Added offline video-poster decoding when the browser cannot decode a video, including HEVC MOV.
- Keep saved image thumbnails and video posters in the database for review after the source is disconnected. Sorting reloads these saved previews.
- Added preview recovery for camera RAW files containing a readable embedded JPEG, and a browser-image fallback for formats such as SVG.

## 3.1.2 — October 6, 2026

- Made scan date, oldest first, the default result order.
- Refresh displayed previews and retry missing previews when the sort order changes. Preview rebuilding no longer delays result sorting or page changes.
- Added a separate progress window while opening and checking a database.

## 3.1.1 — October 6, 2026

- Keep database information visible while its item count and size refresh during scanning and saving.

## 3.1.0 — October 5, 2026

- Moved database queries and writes to a background worker using browser disk storage and limited caches.
- Stream database opening and saving in chunks, and preserve committed database snapshots while saving.
- Commit completed scan records and checkpoints together, with bounded write queues.
- Added cleanup of abandoned working storage while protecting active sessions and standalone recovery snapshots.

The app's **About** section includes the earlier changelog.
