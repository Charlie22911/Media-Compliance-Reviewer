# Changelog

## 3.3.1 — Unreleased

- Coalesce database status updates instead of recounting the catalog for each scanned file.
- Coordinate preview decoding separately from parallel file hashing, check image headers before decoding, and retain placeholders after resource-limit failures.
- Load card summaries and page duplicate locations in groups of 100; use the same matching location for display and inspection.
- Report snapshot-copy progress through the Forge bridge and avoid retrying snapshots whose outcome is unknown.
- Space automatic saves according to database size and save duration, add a minimum save interval in Maintenance, and reuse a saved snapshot for local recovery.
- Stream matching report records to the chosen file; finish scanning before exporting. Download-only browsers receive numbered report parts.

## 3.3.0 — October 6, 2026

- Add configurable parallel file workers under Scan speed: default 4, adjustable from 1 to 8.
- Prepare file reads, fingerprints, and common-image thumbnails concurrently, then publish results in discovery order.
- Bound pending file preparation to the selected worker count; keep database publication and heavier preview decoders coordinated.
- Preserve cancellation, retries, saved worker settings, and resume checkpoints with parallel preparation.

## 3.2.6 — October 6, 2026

- Keep folder traversal within the Forge iterator limit, including deep folder trees.
- Release temporary source handles while preserving shared connections.
- Retry recoverable folder reads, media reads, fingerprints, and database operations up to three times after the initial attempt.
- Roll back failed database batches before replaying them, preserving completed records and pending writes.
- Serialize database snapshots with scan transactions so automatic saves do not fail from transaction contention.

## 3.2.5 — October 6, 2026

- Fit shows the full image within the thumbnail frame; Fill crops around the center.
- Select thumbnails immediately, prevent overlapping review actions, and avoid rendering uncommitted decisions during page refreshes.
- Show compact loading feedback after moving items without retaining the previous page height.
- Add Log for recent activity, errors, saved scan stop reasons, and text export.
- Prevent media cleanup after a committed record from rolling back another operation.

## 3.2.4 — October 6, 2026

- Use stable Found order by default and add Reset view to clear sorting and filters.
- Preserve the saved sequence when resuming, with newly found items appended at the end.
- Load only the replacements needed after review actions, preserving the remaining cards and previews.
- Update location totals without rebuilding cards or reloading their thumbnails.
- Keep displayed items in place during automatic scan updates, and prepare replacement cards before updating the grid.

## 3.2.3 — October 6, 2026

- Discover folders while processing media, so folder reads can overlap fingerprinting and preview creation.
- Pause discovery when enough media is queued, and save discovered paths between media transactions so a failed item does not discard pending work.
- Handle cancellation between media jobs without starting another hash on the stopped worker.

## 3.2.2 — October 6, 2026

- Process discovered media between small batches of folder discovery so thumbnails and review results can appear before the whole folder tree is listed.
- Keep pending work and completed checkpoints in the database, prioritize already discovered media when resuming, and limit retained directory iterators.

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
