# Media Compliance Reviewer

An offline Windows browser tool for finding image and video files, reviewing them, and recording decisions in a portable SQLite database.

The app scans folders you choose, groups duplicate content, and organizes items into **To be reviewed**, **Compliant**, **Non-compliant**, and **Evidence**. Review decisions are made by the person using the tool. Scanning does not change, move, or delete originals.

## Download and open

1. Open **Releases** on this repository and download **Media-Compliance-Reviewer.html** from the latest release's assets.
2. Save it on this computer, then open it in a current desktop version of Microsoft Edge or Google Chrome on Windows.
3. Keep the HTML file available for future use. No installation or internet connection is needed to run the downloaded app.

The main download includes its Forge wrapper, file-access prompts, database runtime, and preview decoders. **Media-Compliance-Reviewer-Standalone.html** contains the same reviewer without the wrapper. Use the main download unless you specifically need the standalone edition.

## Start a review

Wait for **Starting database** in Activity to finish. Database controls stay disabled until storage is ready, then the database chooser opens automatically.

1. Choose **Create database** for a new review or **Open existing database** to continue one. Select a writable `.sqlite` or `.db` file. After opening a file, wait for the separate **Checking database** window to close.
2. Choose **Select folder and scan**. Check the scan mode, file types, and exclusions, then choose **Choose folder and start scan**. You can select a local folder, mapped drive, or accessible network share. For a UNC path, paste the path into the Windows folder picker's address bar.
3. Use **Review media while scan continues** to review early, or continue after scanning finishes. To continue an interrupted scan, choose **Resume scan** and reconnect the original folder if requested.
4. Select items and choose a review action. Double-click a thumbnail or choose **Inspect** for a larger view, details, locations, and notes.
5. Progress is saved in the browser as you work. The portable database file saves automatically every **five minutes** when changes are waiting and write access is available, and again when scanning ends. Choose **Save database** whenever you need an up-to-date file, then wait for saving to finish before moving it.

Use the app's **Help** button for detailed instructions and **About** for the version, changelog, and decoder licenses.

## Scan settings and results

- Folder discovery continues while matching files are fingerprinted and their previews are created. Discovery pauses when enough files are waiting to be processed, keeping the amount of queued work limited. Counts grow as discovery continues. Resume skips completed file jobs and completed folders; an interrupted folder may be listed again.
- Items appear in Found order by default. Resuming a scan keeps the saved sequence and appends newly found items at the end. Scan updates keep displayed items in place and update their location counts. When you mark items, the remaining cards move into the gaps and only the replacements needed to fill the page are loaded. Choose a sort order or filters when needed. Reset view clears those choices and restores Found order with all file types shown. Older databases retain their existing stored order in this view.
- **Quick** selects common image and video formats. **Deep** selects all listed formats, including camera RAW. **Custom** uses your selection. Only selected file types are scanned.
- Scan exclusions can skip Application Data inside user folders and files last modified more than a chosen number of years ago. Zero years includes all ages. ZIP scanning is optional.
- Large files can use sampled quick fingerprints. A quick fingerprint is a candidate match, not a full-file verification. Evidence capture verifies a full SHA-256 before preserving an original.
- Results start in **Found order · first found first**. Search, scanned-folder and file-type controls narrow the displayed results without changing scan settings.
- Choose 20, 40, 60, 100, or 200 **Items per page**, or enter a page number and press **Go** or Enter. Changing pages or sort order clears the current selection.

## Saved previews and originals

Image thumbnails and single-frame video posters are stored in the database. They remain available after sorting, saving and reopening, or disconnecting the original folder. Each preview is at most 256 pixels on its longest side and 32 KiB. The app loads the displayed page's previews rather than every stored preview.

Missing previews need access to the original once. Reconnect the source folder and change the sort order to retry creating them. This work waits until an active scan finishes. Older databases may have lost previews under an earlier storage budget; those previews also need the source once to be recreated.

HEIC/HEIF decoding and a video-poster fallback, including HEVC MOV, are included offline. RAW previews use a readable JPEG embedded by the camera. A filename extension alone does not guarantee decoding: damaged files, unsupported codec variants, RAW files without an embedded JPEG, or files exceeding decoder resource limits may retain a placeholder. Saved video posters do not guarantee browser playback of the original video.

## Evidence and database care

Evidence preserves an encrypted original in the database and requires an Evidence password. Keep the password safe; there is no password recovery. Ordinary review records and thumbnails are not encrypted. Capturing Evidence does not remove the original from its folder.

Use **Maintenance → Upgrade database** to update an older database format. Save an upgraded copy when requested. Maintenance also provides integrity checks and cleanup tools; read their descriptions before making permanent changes.

The browser keeps a working copy locally. Both editions offer **Recover browser database** when a saved working database is available. Recovery reopens the committed local data without copying the whole database. You can resume scanning after recovery; choose **Save database** to reconnect a portable file and enable its five-minute auto-save. Browser storage is not a backup and may be removed when browser data is cleared. Keep regular copies of the portable database.

Allow enough disk space for the working copy and saved snapshots. Saved previews increase the database's size as the collection grows. Evidence capture checks the estimated total database size before adding an encrypted original. The default threshold is **2.5 GB**. To raise it, open **Maintenance → Database size limit for Evidence** and choose **5 GB**, then save the database. The choice is kept with that database. Normal scans can continue beyond this threshold while browser storage is available; existing records and previews are kept. Browser storage availability can impose a lower limit. Opening and saving large databases can take time; watch the progress indicators.

## Scan speed

Choose **Scan speed → Parallel file workers** before starting or resuming a scan. The default is **4**, with **1–8** available. File reads and fingerprints run concurrently; results are saved in discovery order. Preview decoding runs one at a time, separately from the selected file-worker count, to reduce peak memory use. The selected worker count is saved with the database.

Start with 4. Fewer workers can help when memory or a network connection is limited; more may help on fast storage. Pending file preparation is bounded by the selected worker count. Database publication, preview decoding, and media within each ZIP archive remain coordinated. Storage, decoding, and database write speed can limit the benefit, so additional workers do not guarantee a proportional speed increase. Cancellation returns unpublished file jobs to the resume queue.

Preview input is limited to 128 MiB and 32 megapixels. Ordinary image headers must provide readable dimensions before decoding; unusual or damaged headers can leave a placeholder even if another viewer can open the file. These checks reduce allocations but do not guarantee a particular process-memory ceiling. The inspector uses bounded decoded images for supported raster formats.

Large duplicate groups show a location count on the card. Inspect an item to browse **Next 100 locations** or return to **First 100 locations**. Search results use a matching location for the filename, path, and inspection.

## Saving and report export

The database status shows the last successful portable-file save. Use **Save database** when you need a current copy before closing or moving it. Status totals can take a few seconds to catch up during scanning.

Routine changes use bounded batches of SQL writes in the browser's working database. Each completed media item's records and resume checkpoint commit together. Local progress metadata is saved about every five seconds, and recovery retains the working database directly. Queued bucket changes take priority over the next waiting scan transaction.

The portable file saves every **five minutes** while changes are waiting; its interval is not increased for large databases. Saves do not overlap, and an active Evidence operation or report export can delay a file save. Manual saves and the end of a scan also update the file. A portable save still prepares and writes a complete database copy, with scan and review writes allowed between copy steps. Watch **Activity** for progress. **Saved locally** refers to browser storage; **file saved** shows the portable file's last save time. Allow enough disk space for the working database, the temporary export snapshot, and the portable file. Failed local saves appear in the database status and Log.

Finish or cancel an active scan before choosing **Export report**. The report includes Non-compliant items and optionally password-protected Evidence. If Evidence was locked before export, it is locked again afterward. Choose a destination file; export writes records in batches, shows progress, and offers Cancel. Review changes wait until export finishes so its contents remain consistent. In browsers without a writable file picker, large reports download as numbered parts of roughly 8 MiB; allow multiple downloads and keep all parts. Parts already downloaded remain if you cancel later.

## Activity log and review feedback

The folders immediately beneath your selected share are visited alphabetically, without regard to letter case. For a home share, these are the user folders. Each user's files and subfolders are processed before moving to the next user. The tool saves discovered paths and the current user folder in the database. Resume uses the saved jobs and checkpoints inside that user folder, then proceeds to later users; earlier user folders are not listed again. An interrupted subfolder may need its listing repeated, and completed files are skipped. The immediate contents of a folder are listed before entering its child folders; photos can be processed while that listing continues. Opening an older scan without an alphabetical cursor preserves its unfinished saved work. Use a fresh scan to find additions in earlier user folders or retry their failed folder listings.

Recoverable folder reads, file reads, fingerprinting, and database operations receive an initial attempt plus up to three retries with short pauses. Retry attempts appear in **Activity** and **Log**, and cancellation remains available while waiting. Successfully discovered paths are kept even if a later entry in the same folder cannot be read. The browser can use write-related wording for a folder-listing error; listing source folders does not write to them. After retries are exhausted, the unreadable folder stays in the scan's error summary. Database batches are replayed only when rollback has confirmed a safe outcome. Permanent problems such as invalid data or exhausted storage require a different action. If a worker failure leaves a write unconfirmed, reopen the last saved database before continuing.

Open **Log** beside About and Help to see recent activity, errors, and why a scan ended. The log includes up to 500 session entries, saved summaries from the last five scans, and up to 20 recent read errors per saved scan. Saved scan details travel with the database; other activity lasts until the tool closes or reloads. **Save log as text** downloads the displayed details. Logs can contain filenames and paths.

If Log reports **Database worker stopped**, it includes the original failure. Reopen your saved SQLite file, or reload the HTML and choose **Recover browser database** to recover locally committed progress. Failed workers are not reused, and unconfirmed writes are not replayed automatically.

Click a thumbnail or checkbox to select it, then choose a selected-item action such as **Compliant**. The bucket tabs switch the results you are viewing. A click on another selection is queued while a review action saves; repeated clicks on the same pending items do not create duplicate actions. Page refills do not hold up the next review write. Evidence capture and report export still coordinate changes while they are running. Failed review writes retain the selection for retry. When items move out of the current bucket, a compact loading box appears while the page fills; the previous page height is released.

**Fit** shows the entire image within the thumbnail frame. **Fill** fills the frame and crops around the center.

## Source and building

The two HTML files are ready to use. To rebuild them, install Node.js 18 or later, then run:

```text
npm install
npm run build
npm run check
```

The optional regression checks use Node.js 24 or later: run `npm run test:startup`, `npm run test:scan`, `npm run test:schema`, `npm run test:identity`, `npm run test:results`, `npm run test:display`, `npm run test:review`, `npm run test:recovery`, and `npm run test:responsive`.

On Windows with Chrome installed, `npm run test:browser` checks both packaged editions using their actual SQLite and preview workers. It delays startup to check that database controls wait, scans a small test folder, groups duplicates, changes a review bucket, and saves and reopens a database. It also checks reopening after a simulated worker failure. File pickers use test handles, so the check does not read your media or databases. To use another Chromium browser, set `MEDIA_REVIEWER_TEST_BROWSER` to its executable path. Test profiles and results are written under `.build/`. These checks do not measure a large scan's memory use or performance on your computer.

The build uses the vendored runtimes and embedded HTML templates. The app does not download code or decoder assets at runtime. External license links in About open websites only when clicked.

- `src/` contains the reviewer, database client and worker, trusted wrapper database host, preview worker, and first-party Forge database transport.
- `scripts/` assembles the standalone reviewer and refreshes the packaged app.
- `vendor/` contains the SQLite and video-decoder runtimes and their license notices.

See [CHANGELOG.md](CHANGELOG.md) and [NOTICE.md](NOTICE.md).
