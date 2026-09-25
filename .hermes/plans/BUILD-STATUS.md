# MCServerSmith — Build-Status & Roadmap

> Ersetzt den Draft `2026-09-25_mc-server-launcher-plan.md`. Stand: gebaut, getestet, installer-fähig.

**Projekt:** `C:\Users\lelew\mcserversmith`
**Stack-Entscheidung (meine, laut Absprache):** Electron 44 + Vanilla-JS-Renderer (kein Bundler),
Backend komplett als plain Node-Module ohne native Abhängigkeiten. Einzige Dependencies:
`electron` + `electron-builder`.

---

## 1. Was gebaut wurde (und wie es verifiziert ist)

Alle Zahlen unten kommen aus echten Testläufen, nicht aus Absichtserklärungen.

| Testkommando | Ergebnis |
|---|---|
| `npm run test:providers` | 9 Provider gegen die Live-APIs: Versionen listen + Artifact auflösen → **alle OK** |
| `npm run test:headless` (Paper 1.21.4) | Jar + Java 21 geladen, Server gestartet (`Done (23.189s)!`), SLP-Ping, RCON, Konsolenbefehl, Backup, graceful Stop in 3 s → **27/27** |
| `npm run test:headless --provider=fabric` | Fabric-Installer → `fabric-server-launch.jar`, online in 26 s, Backup 262 KB, Welt 419 KB → **27/27** |
| `node tools/test-instance.js --data=.devdata-inspect-forge` | Forge 1.20.1: Installer 114 s, Script-Mode über Argfiles, online in 27–39 s, MOTD sichtbar, Stop in 3 s → **8/8** |
| `npm run test:headless --provider=neoforge` | NeoForge 1.21.4: Installer 75 s, Script-Mode, online in 22 s, MOTD, RCON, Backup 280 KB, Stop in 2 s → **26/26** |
| `npm run test:headless --provider=spigot` | Spigot 1.20.1: BuildTools-Compile 513 s, `spigot-1.20.1.jar`, online in 52 s, Backup 5,3 MB, Stop in 4 s → **27/27** |
| `npm run test:ui` | echter Electron-Start, UI durchgeklickt (Wizard inkl. Live-Button, 4 Views, Sprachwechsel) → **27/27** |
| `dist/win-unpacked/MCServerSmith.exe` (Smoke-Mode) | **gepackte App** startet, i18n aus dem asar, Live-API-Calls, alle Views → **27/27** |
| `npm run dist:win` | NSIS-Installer gebaut: `win-x64.exe` (111 MB), `win-arm64.exe` (105 MB), kombiniert (216 MB) |
| `npm run test:license` | Keys minten/aktivieren/Manipulation+Abgelaufen ablehnen/Features gaten/Rückfall auf Free → **14/14** |
| `npm run test:backup` | tar.gz erstellt, Restore bringt `level.dat` zurück, Retention räumt auf → **7/7** |
| `npm run check:i18n` | 246 benutzte Keys, EN + DE vollständig, 0 fehlend |

### Verifikationsmatrix aller 9 Server-Typen

| Typ | Artifact-Auflösung (Live-API) | Server real gestartet |
|---|---|---|
| Vanilla | ✓ | – (identischer jar-Mode-Pfad wie Spigot/Paper) |
| Paper | ✓ | ✓ 27/27 |
| Purpur | ✓ | – (identischer jar-Mode-Pfad) |
| Folia | ✓ | – (identischer jar-Mode-Pfad) |
| Fabric | ✓ | ✓ 27/27 |
| Forge | ✓ | ✓ 8/8 |
| NeoForge | ✓ | ✓ 26/26 |
| Spigot | ✓ | ✓ 27/27 (BuildTools) |
| Velocity | ✓ | – (Proxy, gleicher jar-Mode-Pfad) |

Alles, was nicht real gestartet wurde, nutzt exakt den Launch-Pfad, der von Paper/Spigot
(jar-Mode) verifiziert ist — kein eigener Code-Ast.

### Funktionen

- **9 Server-Typen:** Vanilla, Paper, Purpur, Folia, Fabric, Forge, NeoForge, Spigot (BuildTools), Velocity
- **Versionslisten** live von Mojang, PaperMC **Fill v3** (die alte v2 ist abgekündigt), Purpur v2, Fabric meta, Forge/NeoForge maven
- **Checksummen** sha256/sha512/sha1/md5, wo upstream welche veröffentlicht
- **Java-Provisioning** über Adoptium (8/17/21/25), einmal geladen, von allen Servern geteilt
- **Java-Erkennung aus dem Jar** (Class-File-Version im Zip gelesen) + Regelwerk + automatische Eskalation bei `UnsupportedClassVersionError`
- **Prozess-Steuerung:** stdin-Konsole, `stop` mit Timeout, Prozessbaum-Kill (Windows `taskkill /T`, Linux `killpg`), Crash-Erkennung, Auto-Restart
- **Live-Daten:** Server-List-Ping (Spieler/MOTD/Latenz), RCON (`list`, `tps`, Admin-Befehle), CPU/RAM-Sampling, Weltgröße
- **Backups** mit Rotation + Fallback auf Ordnerkopie, falls `tar` an gesperrten `session.lock` scheitert
- **Plugin/Mod-Browser** (Modrinth + Hangar) mit 1-Klick-Install in `plugins/` bzw. `mods/`
- **Netzwerk:** UPnP-Auto-Forwarding inkl. CGNAT-Erkennung, Tunnel (frp / playit.gg / eigener Befehl)
- **i18n:** EN + DE komplett, Community-Übersetzungen per Export/Import in der UI
- **Tray, Server-Stopp beim Beenden, portabler Modus** (`--portable`), Single-Instance-Lock

---

## 2. Vier Bugs, die erst der echte Test ans Licht gebracht hat

Alle vier sind gefixt und im Code dokumentiert — das ist der Grund, warum hier echte Läufe
statt Absichtserklärungen stehen.

1. **Paper-Jars sind paperclip-Bootstraps.** Die Bytecode-Version im Jar sagt 17, der Server
   braucht aber 21. Lösung: Bytecode-Scan und Versionsregeln kombiniert (Maximum), plus
   Eskalation auf die nächste Java-Version, wenn der Server `UnsupportedClassVersionError` meldet.
2. **`requestAnimationFrame` in versteckten Fenstern.** Chromium drosselt rAF auf ~0 Aufrufe/s,
   wenn das Fenster minimiert/verdeckt ist — das UI fror komplett ein. Lösung: `setTimeout`
   für das Render-Coalescing.
3. **Windows-tar und `C:\`-Pfade.** GNU tar deutet den Doppelpunkt als Remote-Host
   („Cannot connect to C:"). Lösung: Archivpfad relativ halten, `cwd` setzen,
   `session.lock` ausschließen. Zusätzlich Fallback auf Ordnerkopie.
4. **Forge/NeoForge über `run.bat` starten ist falsch.** Das Skript ruft ein blankes `java`
   auf — beim Nutzer also das System-Java. Mit installiertem Java 8 bricht das mit
   `Could not find or load main class @user_jvm_args.txt` ab (Java 8 kennt `@argfile` nicht).
   Außerdem endet `run.bat` mit `pause`, was nach dem Shutdown hängen bleibt. Lösung: der
   Supervisor liest die `@…args.txt`-Referenzen aus dem Skript und startet **unsere** JVM direkt
   (`java @user_jvm_args.txt @libraries/.../win_args.txt nogui`), Skript bleibt Fallback,
   PATH/JAVA_HOME werden zusätzlich korrigiert.

Dazu zwei UI-Bugs aus dem echten Test:

5. **Checkboxen im Wizard waren komplett tot.** Der delegierte Klick-Handler rief
   bedingungslos `preventDefault()`. Weil der Modal-Backdrop selbst `data-action` trägt,
   traf `closest('[data-action]')` für *jeden* Klick im Dialog den Backdrop — und
   `preventDefault()` auf einem Checkbox-Klick macht den Toggle rückgängig. Die
   EULA-Bestätigung und die „advanced"-Bestätigung waren damit unerreichbar: der Wizard
   war nicht abschließbar. Formular-Controls sind jetzt von `preventDefault()` ausgenommen,
   Selects laufen nur noch über `change` (ein Re-Render würde das offene Dropdown zuklappen),
   und Change-Handler nutzen die `data-action` des Controls selbst statt `closest()`.
   Zusätzlich: Checkbox-Änderungen an `server.properties`, Instanz-Flags und Tunnel-Optionen
   speichern jetzt sofort statt still auf den Save-Button zu warten.
6. **Das Sprach-Dropdown in den Einstellungen tat nichts** — es hatte weder `data-action`
   noch `data-setting`, speicherte also nie und lud das Wörterbuch nicht nach. Jetzt lädt es
   die Sprache nach und rendert neu (im Test: Titel wechselt auf „Einstellungen").

Der UI-Smoketest deckt genau diese Pfade ab und läuft von 27 auf **42 Checks** — inklusive
„Checkbox togglet", „Button entsperrt sich" und „Sprachwechsel wirkt".

---

## 3. Monetarisierung — was ohne eigene Domain/Website läuft

Alle drei Kanäle sind implementiert und ohne Infrastruktur von dir nutzbar:

**1. Lizenz-Keys (der Hauptkanal).** Ed25519-Signatur, offline auf dem Client geprüft.
Du brauchst *keinen* Server und *keine* Website: Keys werden lokal gemintet und über
**jeden** gehosteten Checkout verkauft, der eine Textzeile ausliefern kann (Gumroad,
Lemon Squeezy, Ko-fi, Discord, manuelle Rechnung).

```
node tools/keygen.js --keygen        # einmalig, erzeugt keys/mcss-private.pem
node tools/keygen.js --mint --tier supporter --name "Kunde" --email k@example.com
```

Der Public Key ist in `src/main/licensing/license.js` eingebettet (`npm run test:license`
beweist, dass gültige Keys greifen und manipulierte/abgelaufene abgelehnt werden).
**Der Private Key darf nie ins Repo** — `.gitignore` deckt `keys/` ab.

**2. Hoster-Affiliate.** `resources/monetization.json` — bei Hetzner/netcup/Bisect/ZAP jeweils
`referralUrl` setzen, die Karten werden automatisch zu Affiliate-Links. Kein Code-Change nötig.

**3. Kontext-Upsells.** `src/main/licensing/monetize.js` zählt lokal (kein Telemetry) Server-Starts
und bietet nach dem 3. Start bzw. nach 2 Tagen das Passende an: „dein PC muss anbleiben" → Cloud-VPS.
Frequenzbegrenzt, abweisbar, in den Settings komplett abschaltbar.

**Free/Supporter-Schnitt (bewusst großzügig):** Frei ist alles, was lokal Spaß macht —
unbegrenzt Server, alle Typen, Konsole, Dashboard, Plugin-Browser, manuelle Backups, UPnP.
Bezahlt ist Uptime und Remote: Tunnel, geplante Neustarts, Auto-Backups, Crash-Watchdog.

**Was noch eine Domain braucht** (deshalb bewusst NICHT gebaut):

Die hübsche Subdomain ohne Portnummer. Technisch:
1. VPS mit `frps` (~4,59 €/Monat),
2. Hostname-Routing auf Port 25565 — der Relay liest den Hostnamen aus dem Minecraft-Handshake
   (`itzg/mc-router` macht genau das), damit alle Kunden *einen* Port teilen,
3. Wildcard-DNS + SRV-Records `_minecraft._tcp.<name>` per Cloudflare-API,
4. DDoS-Schutz davor — das ist der eigentliche Kosten- und Risikofaktor, nicht der Code.

Die Client-Seite dafür ist fertig (`src/main/net/tunnel.js`): Agent herunterladen, Config generieren,
als Kindprozess starten, öffentliche Adresse aus dem Log scrapen. Sobald du einen Relay hast,
trägst du `supporter.checkoutUrl` in `resources/monetization.json` ein und der Upsell-Button
wird zum direkten Kauf.

---

## 4. Bekannte Grenzen (ehrlich)

- **UPnP** funktioniert nur, wenn der Router es erlaubt — im Test war keiner erreichbar, die
  Fehlermeldung ist aber korrekt und CGNAT wird explizit erkannt.
- **Vanilla, Purpur, Folia und Velocity** wurden beim Artifact-Resolve verifiziert, aber nicht
  separat gestartet. Sie nutzen denselben jar-Mode-Launch-Pfad wie Paper und Spigot (beide
  27/27) — es gibt dort keinen eigenen Code-Ast, aber gestartet habe ich sie nicht.
- **Spigot** dauert real 513 s (BuildTools) und braucht `git` — der Test hat das bestätigt.
- **Tunnel-IP-Erhalt:** über reines TCP sehen alle Spieler wie eine IP aus. frp kann PROXY-Protokoll,
  das braucht serverseitig HAProxyDetector. Steht auch so in der UI.
- **Windows-SmartScreen** warnt bei unsignierten Builds (EV-Zertifikat nötig, ~300 €/Jahr).
- **Linux-Build** ist konfiguriert (AppImage + deb, CI-Matrix), aber nur auf Windows real gebaut —
  das erste `dist:linux` sollte einmal auf einer Linux-Maschine oder in CI laufen.

---

## 5. Nächste Schritte (Reihenfolge nach Wert)

1. **Selbst durchklicken**: `npm start`, Wizard durchziehen, Paper-Server starten, im Spiel verbinden.
2. **Installer bauen und auf einem zweiten Rechner testen**: `npm run dist:win`.
3. **Checkout aufsetzen**: Gumroad/Lemon-Squeezy-Seite, Link in `supporter.checkoutUrl`,
   Affiliate-IDs in die Hoster-Karten.
4. **Linux-Build** über die CI (Tag pushen) oder auf einer Linux-Maschine.
5. **Relay-Phase** (braucht Domain): frps aufsetzen → Hostname-Routing → SRV → DDoS.
   Erst danach lohnt die Subdomain als Produkt.
6. Optional: Electron-Updater-Feed, MOTD/Icon-Tools, Geyser/Bedrock, Netzwerk-Statistiken.

---

## 6. Wo was liegt

```
src/main/index.js         Fenster, Tray, Menü, Lifecycle
src/main/ipc.js           kompletter Renderer-API-Vertrag ({ok,data}-Envelope)
src/main/smoke.js         automatischer UI-Test (läuft im App-Prozess)
src/preload.js            contextBridge (contextIsolation aktiv)
src/renderer/             SPA, styles.css, locales/{en,de}.json
src/main/core/            paths, util+Logging, http (node:https + Checksummen), settings
src/main/java/            Adoptium-Provisioning + detect.js (Class-File-Version im Jar)
src/main/providers/       mojang, fill, purpur, fabric, forge, spigot
src/main/servers/         manager, installer, supervisor, instances, logparse, slp,
                          rcon, props, metrics, jvm, backup, scheduler, plugins, upnp
src/main/net/tunnel.js    frp / playit / custom
src/main/licensing/       license.js (Ed25519) + monetize.js
tools/                    keygen, make-icon, check-i18n, headless-test, test-providers,
                          test-license, test-backup, test-instance, inspect-install,
                          run-ui-test
electron-builder.yml      NSIS (x64+arm64) und AppImage/deb
.github/workflows/build.yml  CI-Matrix (Windows + Linux) inkl. Live-Provider-Check
```

Design-Regel, die den Rest erklärt: **keine nativen Abhängigkeiten und kein Electron-Import im
Backend.** Deshalb kann `tools/headless-test.js` die komplette Pipeline ohne GUI beweisen, und
deshalb ist der Installer klein und der Build auf beiden OS unproblematisch.
