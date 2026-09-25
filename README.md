# MCServerSmith

A Minecraft **server** launcher for Windows and Linux — the same idea as the official
Minecraft launcher, but for servers.

Pick a version, pick a flavour, hit **Start**. MCServerSmith downloads the server
software *and* the exact Java runtime it needs, starts the server and gives you a live
dashboard: players online, join address, console, TPS, RAM/CPU, world size, backups,
a plugin/mod browser and an optional tunnel so nobody has to configure port forwarding.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ⛏ MCServerSmith                                    46.124.150.5:25565  │
├────────────────┬─────────────────────────────────────────────────────────┤
│  + New server  │  Overview  Console  Players  Plugins  Backups  Network   │
│                │                                                         │
│  ● Kumpel      │  Status    Players   Uptime      Join address           │
│    2/20        │  online    2/20      3h 14m      kumpel.play.example    │
│  ○ Creative    │                                                         │
│                │  RAM  ▓▓▓▓▓▓▓░░░  2.1 GB / 4 GB                         │
│  ⚙ Settings    │  CPU  ▓▓▓░░░░░░░  23.4 %                                │
│  ☕ Runtimes    │  TPS  ▓▓▓▓▓▓▓▓▓▓  20.0, 20.0, 19.9                     │
│  ☁ 24/7 hosting│                                                         │
│  ★ Supporter   │  [Start] [Restart] [Stop] [Force stop]                  │
└────────────────┴─────────────────────────────────────────────────────────┘
```

---

## What actually works

Verified end-to-end on Windows by `npm run test:headless` (real download, real server,
real ping, real shutdown):

| Area | Status |
|---|---|
| Server types | Vanilla, Paper, Purpur, Folia, Fabric, Forge, NeoForge, Spigot (BuildTools), Velocity |
| Version lists | live from Mojang, PaperMC **Fill API v3**, Purpur v2, Fabric meta, Forge/NeoForge maven |
| Checksums | sha256 / sha512 / sha1 / md5 verified where upstream publishes them |
| Java runtimes | Adoptium Temurin 8 / 17 / 21 / 25, downloaded once, shared by all servers |
| Java requirement | read from the **class-file version inside the jar**, combined with a version rule table, with automatic escalation if the server still reports `UnsupportedClassVersionError` |
| Process control | stdin console, graceful `stop` with timeout, process-tree kill, crash detection, optional auto-restart |
| Live data | Server List Ping (players/MOTD/latency), RCON (`list`, `tps`, admin commands), CPU/RAM sampling, world size on disk |
| Backups | tar.gz with rotation; automatic folder-copy fallback that survives locked `session.lock` files |
| Addons | one-click install from **Modrinth** and **PaperMC Hangar** into `plugins/` or `mods/` |
| Networking | UPnP auto port-forwarding, CGNAT detection, tunnels (frp / playit.gg / any custom command) |
| Monetisation | offline Ed25519 licence keys, hoster affiliate cards, contextual cloud upsell |
| i18n | English + German shipped, community translation import/export in the UI |

---

## Quick start (development)

```bash
git clone <this repo> mcserversmith
cd mcserversmith
npm install            # only electron + electron-builder
npm start              # launches the app
npm run dev            # same, with devtools
```

Requirements: Node 20+. Everything else the app needs, it downloads itself.
`git` is only required if you use the Spigot/BuildTools server type.

### Verify it really works

```bash
npm run test:headless        # downloads Paper 1.21.4 + Java 21, starts it, pings it, stops it
npm run test:providers       # hits every upstream API and resolves a real artifact per type
npm run test:license         # mints real keys and checks the gating
npm run test:backup          # backup + restore + retention against a real instance
npm run test:ui              # drives the real UI (wizard, views, language switch) and reports
npm run check:i18n           # translation completeness
```

`test:headless` flags: `--mc=26.3`, `--provider=fabric|forge|...`, `--memory=1024`, `--port=25599`, `--keep`, `--data=<dir>`.

Two helpers for debugging a single install:

```bash
node tools/inspect-install.js --provider=forge --mc=1.20.1   # shows what the install produced
node tools/test-instance.js --data=.devdata-inspect-forge    # starts an existing instance and reports
```

Verified paths so far: **Paper 1.21.4** (27/27 e2e checks), **Fabric 1.21.4** (installer flow),
**Forge 1.20.1** (114 s installer, script mode, 39 s to "Done", stop in 4 s).

---

## Building installers

```bash
npm run dist:win       # NSIS installer (x64 + arm64)
npm run dist:linux     # AppImage + .deb
```

Building for the *other* OS needs a matching runner — `.github/workflows/build.yml`
does both on tags (`git tag v0.1.0 && git push --tags`).

Windows SmartScreen will warn about an unsigned build. That is unavoidable without a
code-signing certificate; set `CSC_LINK` / `CSC_KEY_PASSWORD` in CI to fix it.

---

## Monetisation — all of it works without a website

The app is designed so you can earn from it **before** you own a domain. Three channels
are implemented; all three are data/config driven.

### 1. Licence keys (the main one)

Keys are **signed offline** with an Ed25519 private key and verified on the client with
an embedded public key. No activation server, no accounts, no telemetry — which means
you can sell them through *any* hosted checkout that can deliver a line of text:
Gumroad, Lemon Squeezy, Ko-fi, a Discord shop, a plain PayPal invoice.

```bash
node tools/keygen.js --keygen                       # once: creates keys/mcss-private.pem
                                                    # paste the printed public key into
                                                    # src/main/licensing/license.js

node tools/keygen.js --mint --tier supporter --name "Max M." --email max@example.com
node tools/keygen.js --mint --tier cloud --days 365 --name "Community X"
node tools/keygen.js --verify MCSS1-....
```

Send the customer the printed `MCSS1-…` string; they paste it into
**Supporter → Activate a key**.

Free vs. Supporter (see `src/main/licensing/license.js`):

| | Free | Supporter (one-time) |
|---|---|---|
| Server types, unlimited instances | ✅ | ✅ |
| Console, dashboard, plugin browser | ✅ | ✅ |
| Manual backups, LAN play, UPnP | ✅ | ✅ |
| Tunnel (no port forwarding) | — | ✅ |
| Scheduled restarts + backup first | — | ✅ |
| Automatic interval backups | — | ✅ |
| Crash watchdog / auto-restart | — | ✅ |

**Keep `keys/mcss-private.pem` secret.** It is git-ignored; losing it means you can no
longer mint keys that existing builds accept.

### 2. Hoster affiliate

`resources/monetization.json` ships cards for Hetzner, netcup, BisectHosting and
ZAP-Hosting. Each entry has a `referralUrl` — set it to your affiliate link and the
"24/7 hosting" cards become revenue. Nothing else to change.

### 3. Cloud upsell & tunnel upsell

`src/main/licensing/monetize.js` watches locally-counted engagement (server starts, days
with a server) and offers the relevant thing at the relevant moment — "your PC has to
stay on for friends to play" → rent a small VPS. Frequency-capped, dismissible, and can
be switched off entirely in Settings.

When you later have your own relay, set `supporter.checkoutUrl` in
`resources/monetization.json` to your shop link and the upsell button becomes a direct
purchase.

---

## Tunnels ("no port forwarding")

Three providers, configured per server on the **Network** tab:

- **UPnP** (free, no config) — the app asks your router to forward the port. Fails on
  carrier-grade NAT; the app detects that and says so instead of pretending.
- **frp** (supporter) — point it at any VPS running `frps`. The app downloads the `frpc`
  binary, generates the config and supervises it. This is the path to your own relay
  business: one VPS, one port per customer, or shared port + subdomain routing later.
- **playit.gg agent** (supporter) — free public service, bring your own agent binary.
- **Custom command** (supporter) — run any tunnel CLI and scrape the public address from
  its output with a regex.

> **IP caveat, stated honestly:** through a plain TCP tunnel every player looks like they
> come from the tunnel host, so IP bans and IP-based plugins see a single address. frp can
> preserve real IPs via PROXY protocol v2, but Minecraft only understands that with a
> server-side plugin (e.g. HAProxyDetector). The Network tab says this too.

### The relay plan (needs a domain, so it is not built yet)

The product idea — sell `name.yourdomain.net` with no port number — needs:

1. a VPS (~€4.59/mo) running `frps`;
2. hostname-based routing on port 25565, reading the hostname out of the Minecraft
   handshake packet (`itzg/mc-router` does exactly this), so all customers share one port;
3. wildcard DNS + per-customer `_minecraft._tcp.<name>` SRV records via the Cloudflare API;
4. DDoS protection in front — this is the real cost and risk of that business, not the code.

Everything on the client side (agent, config generation, address display) is already in
`src/main/net/tunnel.js`.

---

## Community translations

English is the source language; German ships as the second. To add a language:

1. In the app: **Settings → Translations → Export template** → you get `en.json`;
2. translate the *values*, keep the *keys*, set `_meta.code` / `_meta.name`;
3. **Settings → Translations → Import translation** — or drop the file into the app's
   `locales/` folder (Settings → Data folder).

User files override the bundled ones and are picked up immediately.
`node tools/check-i18n.js` reports missing, empty and still-English strings.

---

## How it is built

```
src/main/index.js            Electron: window, tray, menu, lifecycle
src/main/ipc.js              the entire renderer API (one {ok,data} envelope)
src/preload.js               contextBridge surface (contextIsolation on)
src/renderer/                vanilla-JS SPA, no bundler, no framework

src/main/core/               paths, fs helpers, logging, node:https HTTP + checksums
src/main/java/               Adoptium provisioning + class-file bytecode detection
src/main/providers/          one module per server flavour, same contract
src/main/servers/
  manager.js                 orchestrator: instances, supervisors, status polling
  installer.js               resolve → java → download → install → configure
  supervisor.js              one server process: stdio, ready detection, kill tree
  instances.js               on-disk layout + metadata
  logparse.js / slp.js / rcon.js / props.js / metrics.js / jvm.js
  backup.js / scheduler.js / plugins.js / upnp.js
src/main/net/tunnel.js       frp / playit / custom
src/main/licensing/          Ed25519 keys + monetisation
```

Design rules worth knowing:

- **No native dependencies.** HTTP, ZIP reading, RCON and the PNG icon are hand-rolled on
  Node built-ins; `tar`/`unzip`/`PowerShell` are used via child processes when present.
  That is what makes a 40 MB installer and painless cross-platform builds possible.
- **The backend never imports Electron.** `ServerManager` runs headlessly, which is why
  `tools/headless-test.js` can prove the whole pipeline without a GUI.
- **Forge/NeoForge are launched through our JVM, not through `run.bat`.** Those scripts call
  a bare `java`, which resolves through PATH — a user with Java 8 installed gets
  `Could not find or load main class @user_jvm_args.txt` (Java 8 has no `@argfile` support).
  They also end in `pause`, which keeps the wrapper alive after shutdown. The supervisor
  therefore parses the `@…args.txt` references out of the script and starts the provisioned
  JVM directly, with the script kept as a fallback (PATH/JAVA_HOME are fixed either way).
- **Data lives outside the app**: `%APPDATA%\MCServerSmith` / `~/.local/share/mcserversmith`,
  overridable with `--data-dir=<path>` or `MCSERVERSMITH_DATA` (portable mode: `--portable`).

Every instance on disk:

```
instances/<id>/
  meta.json          configuration, licence-relevant state, stats
  manifest.json      exact artifact URLs + checksums → reproducible rebuilds
  server/            server.properties, world/, plugins/ or mods/, eula.txt, the jar
  logs/latest.log    console capture written by the launcher
  backups/           tar.gz snapshots with retention
```

---

## Legal notes

- Not affiliated with Mojang or Microsoft. Server jars are **never** mirrored — they are
  always fetched from Mojang, PaperMC, Purpur, Fabric or Forge directly, over HTTPS, and
  verified against upstream checksums where published.
- The Minecraft EULA is shown and must be accepted in the UI before the first start; the
  app only writes `eula=true` after that.
- SpigotMC's site is deliberately **not** scraped for downloads (no public API, and their
  terms prohibit it). Spigot is offered through the official BuildTools flow instead.
- If you sell keys: you are selling a service to a customer, so you need the usual basics
  in your shop (imprint, terms, VAT handling). Using a hosted checkout like Gumroad,
  Lemon Squeezy or Paddle as merchant of record keeps the VAT paperwork off your desk.

## Licence

MIT. Do what you want with it — including building your own version with your own
branding, your own relay and your own store.
