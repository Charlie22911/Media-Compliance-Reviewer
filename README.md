# Media Compliance Reviewer

An offline Windows browser tool for finding image and video files, reviewing them, and recording decisions in a portable SQLite database.

The app scans folders you choose, groups duplicate content, and organizes items into **To be reviewed**, **Compliant**, **Non-compliant**, and **Evidence**. Review decisions are made by the person using the tool. Scanning does not change, move, or delete originals.

## Download and open

1. Open **Releases** on this repository and download **Media-Compliance-Reviewer.html** from the latest release's assets.
2. Save it on this computer, then open it in a current desktop version of Microsoft Edge or Google Chrome on Windows.
3. Keep the HTML file available for future use. No installation or internet connection is needed to run the downloaded app.

The main download includes its Forge wrapper, file-access prompts, database runtime, and preview decoders. **Media-Compliance-Reviewer-Standalone.html** contains the same reviewer without the wrapper. Use the main download unless you specifically need the standalone edition.

## Start a review

1. Choose **Create database** for a new review or **Open existing database** to continue one. Select a writable `.sqlite` or `.db` file. After opening a file, wait for the separate **Checking database** window to close.
2. Choose **Select folder and scan**. Check the scan mode, file types, and exclusions, then choose **Choose folder and start scan**. You can select a local folder, mapped drive, or accessible network share. For a UNC path, paste the path into the Windows folder picker's address bar.
3. Use **Review media while scan continues** to review early, or continue after scanning finishes. To continue an interrupted scan, choose **Resume scan** and reconnect the original folder if requested.
4. Select items and choose a review action. Double-click a thumbnail or choose **Inspect** for a larger view, details, locations, and notes.
5. Choose **Save database** and wait until the saving indicator disappears before closing the app or moving the database. Automatic saving is active when the app has permission to write the database. During scans, saves are spaced about a minute apart.

Use the app's **Help** button for detailed instructions and **About** for the version, changelog, and decoder licenses.

## Scan settings and results

- **Quick** selects common image and video formats. **Deep** selects all listed formats, including camera RAW. **Custom** uses your selection. Only selected file types are scanned.
- Scan exclusions can skip Application Data inside user folders and files last modified more than a chosen number of years ago. Zero years includes all ages. ZIP scanning is optional.
- Large files can use sampled quick fingerprints. A quick fingerprint is a candidate match, not a full-file verification. Evidence capture verifies a full SHA-256 before preserving an original.
- Results start in **Scan date · oldest first** order. Search, scanned-folder and file-type controls narrow the displayed results without changing scan settings.
- Choose 20, 40, 60, 100, or 200 **Items per page**, or enter a page number and press **Go** or Enter. Changing pages or sort order clears the current selection.

## Saved previews and originals

Image thumbnails and single-frame video posters are stored in the database. They remain available after sorting, saving and reopening, or disconnecting the original folder. Each preview is at most 256 pixels on its longest side and 32 KiB. The app loads the displayed page's previews rather than every stored preview.

Missing previews need access to the original once. Reconnect the source folder and change the sort order to retry creating them. This work waits until an active scan finishes. Older databases may have lost previews under an earlier storage budget; those previews also need the source once to be recreated.

HEIC/HEIF decoding and a video-poster fallback, including HEVC MOV, are included offline. RAW previews use a readable JPEG embedded by the camera. A filename extension alone does not guarantee decoding: damaged files, unsupported codec variants, RAW files without an embedded JPEG, or files exceeding decoder resource limits may retain a placeholder. Saved video posters do not guarantee browser playback of the original video.

## Evidence and database care

Evidence preserves an encrypted original in the database and requires an Evidence password. Keep the password safe; there is no password recovery. Ordinary review records and thumbnails are not encrypted. Capturing Evidence does not remove the original from its folder.

Use **Maintenance → Upgrade database** to update an older database format. Save an upgraded copy when requested. Maintenance also provides integrity checks and cleanup tools; read their descriptions before making permanent changes.

The browser keeps a working copy locally. That storage is not a backup and may be removed when browser data is cleared. Keep regular copies of the saved portable database. The wrapped edition requires reopening the saved database; standalone browser recovery, when offered, uses a saved local snapshot.

Allow enough disk space for the working copy and saved snapshots. Saved previews increase the database's size as the collection grows. Evidence capture is blocked if adding an original would exceed the 500 MiB database safety limit. Opening and saving large databases can take time; watch the progress indicators.

## Source and building

The two HTML files are ready to use. To rebuild them, install Node.js 18 or later, then run:

```text
npm install
npm run build
npm run check
```

The build uses the vendored runtimes and embedded HTML templates. The app does not download code or decoder assets at runtime. External license links in About open websites only when clicked.

- `src/` contains the reviewer, database client and worker, trusted wrapper database host, and preview worker.
- `scripts/` assembles the standalone reviewer and refreshes the packaged app.
- `vendor/` contains the SQLite and video-decoder runtimes and their license notices.

See [CHANGELOG.md](CHANGELOG.md) and [NOTICE.md](NOTICE.md).
