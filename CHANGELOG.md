# Changelog

All notable changes to MCServerSmith. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver.

## [1.0.0] — 2026-09-28

**The first release that does everything the app claims.** It is also the release that
makes itself updatable: the app now checks the GitHub release feed, downloads a newer
build in the background and installs it on the next restart — and every release is
pushed to itch.io automatically.

Two reported defects, one the tests found on the way, and three that the release work
exposed. They shared a theme: the app said nothing while doing nothing, and the errors
it did throw were swallowed.

### Added
- **A real updater.** `electron-updater` against this repo's GitHub releases: the
  Settings tab has an Updates card (installed version, status, "Check now",
  download, "Restart and install"), the check runs in the background on start when
  "Check for updates" is on, a finished download installs on the next quit, and the
  card states *why* a build cannot self-update instead of showing a dead switch.
  Store, Flathub/Snap, winget/Scoop and itch-app installations stay off — those
  channels update their own copies (`MCSERVERSMITH_STORE=1` for managed builds, path
  detection for itch).
- **itch.io as a distribution channel.** `tools/itch-publish.js` + `npm run
  publish:itch` push the built artifacts with butler (one channel each: `windows`,
  `linux`, optionally `windows-arm64`, `linux-deb`), and the release job does the
  same automatically on every tag as soon as the `BUTLER_API_KEY` secret exists —
  no manual upload step in the delivery path.
- `npm run test:updater` — drives the real feed from inside Electron: version maths,
  the "update available" branch with a faked old version, the artifact chosen for
  this platform, and the start of a real download.
- `npm run check:update` — the same contract without Electron (CI-safe): version
  comparison, channel policy, and does the newest release actually carry `latest.yml`
  plus both platforms' artifacts.
- `npm run inspect:asar` — lists what is inside a packaged `app.asar` and compares it
  against the runtime dependencies in `package.json`. This is what caught the bug below.
- `node tools/run-ui-test.js --packaged` — the same UI smoke test against
  `dist/win-unpacked/MCServerSmith.exe`, so an asar-only bug cannot slip through.

### Fixed
- **The packaged app would have shipped without its updater.** electron-builder's
  `files` list *replaces* the default `**/*`, and the list did not include
  `node_modules` — so `app.asar` had no `electron-updater` at all. In a packaged
  build the updater is the active one, so the first installer would have started
  broken. `node_modules/**/*` is now listed, `tools/inspect-asar.js` proves it is in
  the archive, and a missing module degrades with an explanation instead of throwing
  during startup.
- **The plugin browser works again — all three layers of it.** Plugin search answered
  `HTTP 400 … failed to parse facets … found ","` for every server whose loader list
  has more than one entry: the Modrinth facet groups joined the tags
  (`categories:paper,bukkit,spigot`) instead of emitting one string per value, which
  is what the API expects. Paper, Purpur, Folia, Fabric and friends were all dead;
  only a single-loader server (Velocity) could search.
- **Hangar (PaperMC) version lists load.** `/projects/{owner}/{slug}/versions` was
  asked for `version=`, a filter that endpoint does not have — also HTTP 400, so a
  Hangar project never showed a single installable build. A Minecraft filter there is
  `platformVersion` and it requires `platform`; the versions now also carry their
  `platformDependencies` as game versions.
- **Installing a module verifies its checksum again.** The install button squeezed
  whichever digest it found into a `sha256` field, and Modrinth publishes
  `sha512` + `sha1` — so the downloader compared a sha512 value against a sha256
  digest and every Modrinth install died with "Checksum mismatch". Each digest now
  reaches the verifier under its own name, which is also why a Hangar install
  (sha256) and a Modrinth install (sha512) both pass.
- **Server → Configuration works again.** `state.props` — the cache of
  `server.properties` — was read and written everywhere but never declared in the
  renderer's state object, so every load went into `undefined` and threw
  `Cannot set properties of undefined (setting '<server-id>')`. Each of those four
  writes sat inside a `try { … } catch { /* ignore */ }`, so nothing surfaced: the
  tab rendered blank fields, the Save button failed silently and the checkbox
  quick-save never wrote. Declared the key (plus the other lazily-created caches:
  `addons`, `backups`, `tunnelStatus`, `java`, `wizardTunnelDraft`), and the props
  load now reports a real failure with a toast instead of swallowing it.
- **The Configuration fields show the values the server actually uses.** A fresh
  instance has no `server.properties` yet, and every field is written back on save
  — so a blank `online-mode` checkbox meant "off", and saving would have kicked
  every player. Missing keys now fall back to Minecraft's own defaults, and a hint
  says the file has not been generated yet.
- **Double-clicking "Next" in the wizard can no longer skip a step.** Steps 1→2 and
  2→3 fetch from live APIs and the button stayed enabled while that request was in
  flight, so the extra clicks were handled too and the wizard ended up on step 5 of
  4 with an empty modal. The transition is now guarded and the button disabled for
  its duration.

### Changed
- **Server flavour cards are readable.** `.type-card` is a `<button>` and never set
  a colour, so the UA stylesheet won: the flavour names (*Vanilla, Paper, Purpur,
  Fabric, …*) rendered pure black on the dark card — a measured contrast of
  **1.32:1**. The cards now carry the theme text colour, the descriptions use a
  brighter secondary tone (`--text-2`, 9.77:1), hover is visible on the whole card
  and `--muted` is nudged up globally for secondary text. `color-scheme: dark` also
  keeps native widgets (select popups, checkboxes, scrollbars) dark.
- The Modrinth/PaperMC dropdown in the plugin browser remembers your choice (a
  repaint used to flip it back silently), and a search that finds nothing for the
  exact Minecraft version retries without that filter instead of showing an empty
  list — a project that only lists patch releases (1.21.4) stays findable from a
  server pinned to "1.21".

### Added (tests and guards)
- `npm run check:state` (`tools/check-state.js`, also in CI): every `state.<key>`
  the renderer touches must exist in the state literal — the exact bug above, with
  write-into-undefined reported separately from a plain read.
- `npm run test:plugins` (`tools/test-plugins.js`, also in CI): the facet builder
  offline, then live Modrinth + Hangar search → versions → download for paper,
  purpur, folia, spigot, velocity, fabric, forge and neoforge, plus a real install
  into a throwaway instance (checksum verified, then removed) and a proof that a
  sha512 digest labelled as sha256 is refused.
- `MCSERVERSMITH_SMOKE_VIEW=<name>` leaves a view on screen for the smoke
  screenshot (`ui-<name>.png`): `wizard` for step 1, or any tab name.

### Verified
- `npm run test:ui` — **140/140**, in the dev run *and* against the packaged build
  (`node tools/run-ui-test.js --packaged`). New coverage: the settings tab really
  switches and loads `server.properties`, the motd
  field is filled in, `online-mode` shows the effective (checked) value, ticking a
  checkbox writes the file with no error toast, computed WCAG contrast for the
  flavour cards (13.09:1 and 9.77:1, and 1.32:1 with the fix reverted), the whole
  plugin flow through the UI (Modrinth search → versions → a real 5.7 MB install
  into `plugins/` verified against the published checksum → remove, then the same
  for Hangar), and the Updates card with a "Check now" that reaches the main
  process — in the packaged build it reaches `uptodate` against the live feed, in a
  dev run it reports `disabled/dev` and says so in the card.
- `npm run test:updater` — 14/14 + 12/12 (two Electron passes against the live
  feed: faked old version → real download starts at ~1.4 MB/s; real version → the
  feed answers and the state settles).
- `npm run check:update` — 16/16.
- `npm run test:plugins` — 26/26 against the live APIs.
- `npm run test:headless` — 27/27 (real Paper download, own JVM, start, ping,
  graceful stop).
- `npm run check:state` fails with the four write sites when `props` is removed
  again — verified against a mutated copy of the renderer.
- Screenshots of the wizard step 1 and of the plugin browser after a Hangar search
  were checked by eye.
- The smoke harness runs with its own `--user-data-dir`: with the installed app
  open, the old harness lost the single-instance lock and quit with **code 0 in two
  seconds, printing nothing**, which reads exactly like a pass. A smoke run that
  cannot take the lock now exits 3 with an explanation.

## [0.4.0] — 2026-09-25

The Files tab, rebuilt as an actual file browser.

### Changed
- **You browse the real folder now.** The Simple/Advanced switch is gone: left is a quick
  access list (server folder, world, mods or plugins, logs, the root config files), right is
  a toolbar with ← back, ↑ up, a clickable path bar and a filter box, and the listing has
  file-type icons, size, modified date and sortable columns. Single click selects (the
  status line below shows what), double click opens, right click opens the same row menu the
  ⋯ button shows.
- **Folders open inside the app.** In the old simple view a click on a folder ran into a
  handler that ignored the target folder, so nothing happened at all — the most confusing
  thing about the tab.
- **Text files open in an in-app editor** (server.properties, configs, logs, .json, .yml,
  .txt, …). Ctrl+S saves, Esc closes, closing with unsaved changes asks first, and a `.bak`
  copy of the previous version is kept. A save is refused when the file changed on disk
  while the editor was open — the server writes to these files while it runs. Files over
  512 KB open read-only and show the tail, which is what you want in a log.
- **Drag & drop import:** drop files or folders onto the listing and they land in the folder
  you are looking at (the paths are resolved in the preload — Electron has no `File.path`).
- **Keyboard:** ↑/↓ move the selection, Enter opens, F2 renames, Delete removes, Backspace
  and Alt+← go back, Esc clears. Delete never fires while a text field has focus.

### Added
- "New file" next to "New folder", plus every row action in one menu.
- `files:read` / `files:write` IPC (jailed, with optimistic locking), `files:path` for
  "Copy path", and the drop relay from the preload to the renderer.
- The smoke run can screenshot what is on screen (`MCSERVERSMITH_SMOKE_SHOT=1` →
  `logs/ui-files.png`); that is how a layout gets reviewed instead of guessed at.

### Verified
- `npm run test:ui` — **113/113** (was 89). New coverage: double click into a folder, the
  path bar and the ← / ↑ buttons, quick access navigation, row selection, keyboard
  shortcuts, Delete inside a text field deleting nothing, the editor round trip (open →
  edit → save → file on disk → `.bak` kept), the discard guard, and the drop import over
  the real IPC chain.
- Dev run *and* the packaged build (`dist/win-unpacked`) pass, and the screenshot of the
  packaged build was checked by eye.

## [0.3.0] — 2026-09-25

UI and usability. Two of these three defects were the same root cause, and the third
made a whole tab look broken.

### Fixed
- **The UI no longer tears itself out from under your hands.** Every status update
  (the 3 s poll and every server event) replaced the whole content area with `innerHTML`.
  The consequences were exactly the reported symptoms: an open dropdown snapped shut
  after a few seconds because its node was detached, a field you were typing in was
  replaced (typed text and caret gone), and the console jumped back to the bottom while
  you were reading it. Now a region is only re-painted when its markup actually changed,
  background updates are held back while a field inside it has focus and applied the
  moment you leave it, and focus, caret, typed text and scroll position survive a
  re-paint.
- **`window.prompt()` does not exist in Electron.** "New folder" and "Rename" in the
  Files tab called it, so both did nothing at all in the packaged app — a file browser
  whose create/rename buttons are dead. `confirm()` works but blocks the whole renderer,
  so it was just as untestable. All of them (files, backups, reinstall, licence key,
  plugins) now use the app's own modal dialogs: Enter submits, Esc or a click on the
  backdrop cancels.
- **The tray menu stops closing by itself.** It was rebuilt from a 5 s timer, and
  replacing a tray context menu closes the menu that is currently open. It is now built
  when it is actually opened (right-click); the tooltip carries the live status instead.
- **Console tab:** the log was rebuilt on every render (scroll reset, filter text lost)
  and the command box stole focus from the filter box on every re-mount. The log is now
  append-only, keeps your reading position and remembers the filter.

### Added
- **Files tab rework:** a per-row `⋯` menu (open, add files here, rename, delete, open in
  file manager, copy path) instead of two always-visible buttons; double-click a row to
  enter a folder or open a file; right-click a row opens the same menu; sortable columns
  (name / size / modified, folders first); a filter box that hides rows in place.
- New IPC `files:path` (absolute path, resolved through the same jailed resolver) for
  "Copy path".
- `tools/run-ui-test.js` now kills a hung run instead of leaving orphaned electron
  processes behind, and the smoke report is written to `logs/ui-smoke.log` next to the
  app log (`app.exit()` truncated it when stdout was a pipe).

### Verified
- `npm run test:ui` — **89/89** checks. The suite grew from 62 to 89: it now drives the
  in-app dialogs and the full files workflow (create → rename → delete through the UI and
  on disk), asserts that a focused input/select keeps node identity, text and focus
  across a status poll, that the console filter survives one, and that the tray menu is
  built on demand rather than on a timer.
- The packaged build was re-tested in smoke mode (`dist/win-unpacked`), because a
  renderer fix only counts once it is inside the artifact users download.

## [0.2.5] — 2026-09-25

Releases are automatic from here on: one tag push builds both platforms, fills the release
and publishes it, and the notes below are generated from this file.

### Added
- **A tag push is all a release needs.** The `release` job uploads the Windows and Linux
  artifacts first and only then publishes the release (`gh release edit --draft=false --latest`),
  so the release is never visible without its files and nobody has to click "Publish".
- **Release notes come from this changelog** (`tools/release-notes.js`, locally `npm run notes`):
  the matching section plus a download table with the correct file names per platform. A tag build
  warns loudly when the section for the version is missing, so notes and binaries cannot drift.
- `tools/check-yaml.js` asserts the whole release path: release job present, publishes itself,
  no appended `--publish` flag, no token in the build jobs, exactly one upload, platform guard,
  notes generator wired up.

### Changed
- `.hermes/plans/BUILD-STATUS.md` is no longer tracked in the repository (the local file stays,
  and `.hermes/` is ignored now).
- README: fixed ASCII box alignment in the UI sketch.

### Notes
- Cumulative release: it also contains 0.2.4 (Minecraft 26.x → Java 25) and 0.2.3 (one release per
  tag with both platforms).
- How to release: bump `package.json`, add a section here, commit, then
  `git tag vX.Y.Z && git push --tags`. The `verify` job aborts when the tag and
  `package.json` disagree.

## [0.2.4] — 2026-09-25

### Fixed
- **Minecraft 26.x needs Java 25, not 21.** Mojang's year.release scheme (`26.1`, `26.3`, …) was
  mapped to Java 21, so a 26.x server was started on the wrong JVM and crashed. The version rule now
  returns 25 for `major >= 26`. Verified: 26.1 and 26.3 resolve to Java 25, and every older mapping
  is unchanged (1.8.9/1.12.2/1.16.5 → 8, 1.17.1/1.19.4/1.20.4 → 17, 1.20.6/1.21.4 → 21).
- **The Java requirement is re-checked on every start, not only once at install time.** Starting an
  instance now combines the bytecode scan of the real launch jar with the version rules again and, if
  the result is higher than the instance's recorded `javaFeature`, provisions that runtime from
  Adoptium and stores the new feature on the instance. A server installed before the 26.x rule
  existed therefore repairs itself on the next start instead of crashing.
- `tools/test-providers.js` prints the heuristic for `26.1` as well, so a regression in that mapping
  is visible in its output on every CI run.

## [0.2.3] — 2026-09-25

Release pipeline only, no product changes — but this is the release users download.

### Fixed
- **GitHub releases are no longer Windows-only.** CI did build both platforms, but the Linux
  files never reached a release the user could see. Three independent defects stacked up:
  1. The build jobs were called as `npm run dist:win -- --publish never` while the script itself
     already ended in `--publish never`. The flag reached electron-builder **twice**, i.e. as the
     array `["never","never"]`. Its CLI validates only string values, so the array slipped through,
     the comparison against `"never"` was false and publishing counted as **enabled**.
  2. electron-builder then published on its own — with the tag taken from `package.json`
     (`v0.2.0`), not from the pushed git tag, so a `v0.2.1` build filled the `v0.2.0` release.
  3. Both matrix jobs published concurrently and each created its own draft, splitting the assets:
     Windows ended up in one draft, the AppImage/`.deb` in a second, duplicate one.
  Now a single `release` job owns releases: it downloads both platform artifacts, asserts that
  `.exe`, `.AppImage` and `.deb` are present, creates exactly one draft per tag and uploads
  everything into it — installers, AppImages, `.deb`, update feeds and `.sha256`.
- **The duplicate-flag trap is defused.** The workflow no longer appends `--publish`, all three
  `npm run dist*` scripts carry exactly one `--publish never`, and the build jobs get no `GH_TOKEN`
  at all, so electron-builder has neither a policy nor a token to publish with.
- **Version and tag are checked before building.** A stale `package.json` version can no longer
  publish into the wrong release; the `verify` job fails on a mismatch.
- **Duplicate releases abort the run** instead of uploading into an arbitrary one of them.
- `tools/check-yaml.js` now asserts all of the above (script flags, no appended flag, no token in
  the build jobs, release job present, single upload, platform guard).

### Notes
- `v0.2.0`, `v0.2.1` and `v0.2.2` produced no usable release: 0.2.0/0.2.2 were duplicate drafts split
  by platform, and 0.2.1 was published by hand from a local Windows build (its files are even named
  `0.2.0`, because `package.json` still said 0.2.0), so it contained no Linux artifacts. All of them
  are superseded by 0.2.3.

## [0.2.0] — 2026-09-25

### Added
- **File browser tab** with two views:
  - *Simple*: only what a server owner normally touches — the world (including nether/end, read from
    `level-name`), the mods or plugins folder, mod configs, logs and the important root files
    (`server.properties`, `eula.txt`, `ops.json`, `whitelist.json`, `banned-*`, `user_jvm_args.txt`, the server jar)
  - *Advanced*: full browse of the server folder with breadcrumbs, sizes and timestamps
- File actions: open a file with the default application, open a folder in the system file manager,
  create folder, add files from disk (multi-select), rename, delete
- Every path from the UI is resolved inside the instance's server folder and rejected if it escapes it
- `server.properties` and `eula.txt` cannot be overwritten by the file import (they belong to the
  Config tab); importing a file that already exists stores a timestamped copy instead of clobbering it

## [0.1.0] — 2026-09-25

First complete build. Everything below was verified against real servers, not just unit-tested.

### Added
- **Nine server types:** Vanilla, Paper, Purpur, Folia, Fabric, Forge, NeoForge, Spigot (BuildTools), Velocity
- **Live version lists** from Mojang, PaperMC Fill v3, Purpur, Fabric, Forge/NeoForge maven
- **Checksum verification** (sha256/sha512/sha1/md5) wherever upstream publishes one
- **Java provisioning** via Adoptium (8/17/21/25), shared between instances
- **Java requirement detection** from the class-file version inside the jar, combined with a
  version rule table — correct even for Paper, whose bootstrap jar lies about it
- **Process supervision:** stdin console, graceful `stop`, process-tree kill, crash detection,
  auto-restart, automatic Java escalation on `UnsupportedClassVersionError`
- **Live dashboard:** server-list ping (players/MOTD/latency), RCON, CPU/RAM sampling, world size
- **Backups** with rotation, `session.lock`-safe, folder-copy fallback if `tar` fails
- **Plugin/mod browser** (Modrinth + PaperMC Hangar) with one-click install
- **Networking:** UPnP port forwarding with CGNAT detection, tunnel support (frp / playit.gg / custom)
- **Monetisation, all offline-verifiable:** Ed25519 licence keys, hoster affiliate cards,
  contextual upsells — no server, no domain required

### Fixed during verification (each found by running the real thing)
- Paper jars are paperclip bootstraps: bytecode says Java 17, the server needs 21 → requirement is
  now `max(bytecode, rule table)` plus escalation at runtime
- `requestAnimationFrame` is throttled to ~0 fps while the window is hidden, which froze the whole
  UI → render coalescing uses `setTimeout`
- `run.bat`/`run.sh` invoke a bare `java`, so a user's system Java 8 broke Forge/NeoForge with
  "Could not find or load main class @user_jvm_args.txt" (`@argfile` needs Java 9+); the scripts also
  end in `pause` and linger after shutdown → the supervisor parses the `@…args.txt` references and
  launches the provisioned JVM directly, with the script as fallback
- GNU tar read `C:\…` as a remote host, breaking backups → relative archive paths plus `cwd`
- Checkboxes inside the wizard could not be ticked: the delegated click handler called
  `preventDefault()` unconditionally and the modal backdrop matched `closest('[data-action]')` for
  every click inside the dialog → form controls are exempt, selects act on `change` only
- The Settings language picker had no handler at all → it now reloads the dictionary
- The wizard's "Next" button stayed disabled when typing the name after picking a type → live update

### Known limitations
- Vanilla, Purpur, Folia and Velocity are verified at the artifact-resolution level but were not
  started separately; they share the jar launch path proven by Paper and Spigot
- The `autoUpdate` setting exists but no update mechanism is wired to it yet
- UPnP needs a router that allows it; no router was reachable in testing
- Windows SmartScreen warns on unsigned builds
- The Linux build is configured and in CI, but only Windows was built locally

[0.1.0]: https://github.com/lelewithheart/mcserversmith/releases/tag/v0.1.0
