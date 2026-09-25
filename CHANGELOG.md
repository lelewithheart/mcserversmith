# Changelog

All notable changes to MCServerSmith. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver.

## [0.2.2] — 2026-09-25

Release pipeline only, no product changes — but the releases users download are built here.

### Fixed
- **GitHub releases are no longer Windows-only.** CI did build both platforms, but the Linux
  files never reached the release: publishing was disabled in the build jobs and the only
  remaining release step pushed checksums. The AppImage and `.deb` stayed inside the run's
  workflow artifacts while the draft release showed Windows only. There is now a dedicated
  `release` job that downloads both platform artifacts and uploads everything — NSIS
  installers, AppImages, `.deb`, update feeds and `.sha256` — into **one** release per tag.
- **Two half-filled drafts for the same tag can no longer happen.** Both matrix jobs used to
  publish concurrently, so each created its own draft and the assets were split across them
  (that is where the v0.2.0 Linux files were hiding). Only the `release` job creates releases now.
- **Version and tag are checked before building.** electron-builder derives the release tag from
  `package.json`, not from the git ref, so a stale version publishes into the wrong release —
  a `v0.2.1` build dropped its files into the `v0.2.0` draft. The `verify` job now fails when the
  pushed tag and `package.json` disagree.
- The `release` job refuses to publish a release without `.exe`, `.AppImage` and `.deb`, so a
  half-built release fails the run instead of shipping silently.
- `tools/check-yaml.js` asserts the above invariants, so a future workflow edit cannot remove the
  release step unnoticed.

### Notes
- `v0.2.1` is a CI tag without a release of its own; its content is included in 0.2.2.
- `v0.2.0` was never published either — it exists as two drafts and is superseded by 0.2.2.

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
