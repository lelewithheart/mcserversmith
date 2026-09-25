# Changelog

All notable changes to MCServerSmith. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver.

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
