# Changelog

All notable changes to MCServerSmith. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions are semver.

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
