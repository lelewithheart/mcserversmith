#!/usr/bin/env node
'use strict';
/**
 * Licence system test — proves the monetisation mechanics actually work
 * offline, without any server or website.
 *
 *   node tools/test-license.js
 *
 * It mints real keys with the private key from keys/ and checks that the app
 * accepts valid ones, rejects tampered/expired ones, and gates paid features.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pubFile = path.join(root, 'keys', 'mcss-public.txt');

// 1. make sure a keypair exists
if (!fs.existsSync(pubFile)) {
  console.log('No keypair yet — running tools/keygen.js --keygen');
  execFileSync(process.execPath, [path.join(__dirname, 'keygen.js'), '--keygen'], { stdio: 'inherit' });
}
const pubB64 = fs.readFileSync(pubFile, 'utf8').trim();

// 2. pretend the build embeds that public key
process.env.MCSERVERSMITH_LICENSE_PUBKEY = pubB64;
// isolated data root so we never touch the real licence store
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcss-lic-'));
process.env.MCSERVERSMITH_DATA = dataRoot;

const { setDataRoot, ensureDirs } = require('../src/main/core/paths');
setDataRoot(dataRoot);
ensureDirs();

const license = require('../src/main/licensing/license');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function mint(extra = []) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'keygen.js'), '--mint', ...extra], { encoding: 'utf8' });
  const m = out.match(/MCSS1-[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/);
  if (!m) throw new Error(`could not parse minted key from:\n${out}`);
  return m[0];
}

console.log(`public key embedded: ${license.isPlaceholder(license.PUBLIC_KEY_B64) ? 'no (env override used)' : 'yes'}\n`);

record('starts on free tier', license.tier() === 'free', `tier=${license.tier()}`);
record('tunnel gated without key', license.hasFeature('tunnel') === false);
let threw = null;
try { license.requireFeature('tunnel'); } catch (err) { threw = err; }
record('requireFeature throws LICENSE_REQUIRED', threw && threw.code === 'LICENSE_REQUIRED');

// valid supporter key
const key = mint(['--tier', 'supporter', '--name', 'Test User', '--email', 'test@example.com', '--days', '365']);
const status = license.activate(key);
record('supporter key activates', status.tier === 'supporter', `tier=${status.tier}`);
record('tunnel unlocked', license.hasFeature('tunnel') === true);
record('autoRestart unlocked', license.hasFeature('autoRestart') === true);
record('cloud-only feature NOT unlocked', license.hasFeature('cloudHosting') === false);

// tampering must fail
const tampered = key.slice(0, -3) + (key.slice(-3) === 'AAA' ? 'BBB' : 'AAA');
let rejected = false;
try { license.activate(tampered); } catch (err) { rejected = /signature|format|readable/i.test(err.message); }
record('tampered key rejected', rejected);

// a key signed for another tier works, but the tier is what the payload says
const cloudKey = mint(['--tier', 'cloud', '--days', '30']);
const cloudStatus = license.activate(cloudKey);
record('cloud key upgrades tier', cloudStatus.tier === 'cloud', `tier=${cloudStatus.tier}`);
record('cloud unlocks cloudHosting', license.hasFeature('cloudHosting') === true);

// expired key must be rejected
const expired = mint(['--tier', 'supporter', '--days', '-1']);
let expiredRejected = false;
try { license.activate(expired); } catch (err) { expiredRejected = /expired/i.test(err.message); }
record('expired key rejected', expiredRejected);

// per-key expiry is recorded; the rejected (expired) key must not be stored
const st = license.status();
record('key store holds only valid keys', st.keys.length === 2, st.keys.map((k) => `${k.tier}${k.valid ? '' : '!'}`).join(', '));

// deactivation drops back down
license.deactivate(cloudKey);
record('deactivating falls back to the next tier', license.tier() === 'supporter', `tier=${license.tier()}`);
license.deactivate(key);
record('deactivating everything returns to free', license.tier() === 'free', `tier=${license.tier()}`);

// ---------------------------------------------------------------- hardware binding
const machineId = license.status().machineId;
record('the machine id is reported and well formed', /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(String(machineId)), machineId);
record('the machine id is stable', license.status().machineId === machineId);

const foreignId = machineId === '0000-0000-0000-0000' ? '1111-1111-1111-1111' : '0000-0000-0000-0000';

const boundHere = mint(['--tier', 'supporter', '--hw', machineId, '--name', 'Bound Buyer']);
record('a key bound to THIS machine verifies', license.verify(boundHere).valid === true);
const boundStore = license.activate(boundHere);
record('a key bound to THIS machine activates', boundStore.tier === 'supporter', `tier=${boundStore.tier}`);
record('the bound key is recorded as bound to this machine',
  boundStore.keys.some((k) => k.boundTo === machineId && k.boundHere === true),
  JSON.stringify(boundStore.keys.map((k) => ({ boundTo: k.boundTo, boundHere: k.boundHere }))));

const boundElsewhere = mint(['--tier', 'supporter', '--hw', foreignId]);
const foreignCheck = license.verify(boundElsewhere);
record('a key bound to ANOTHER machine does not verify',
  foreignCheck.valid === false && foreignCheck.boundElsewhere === true, foreignCheck.reason);
let foreignRejected = null;
try { license.activate(boundElsewhere); } catch (err) { foreignRejected = err; }
record('activating a foreign-bound key fails with a readable reason',
  !!foreignRejected && /machine/i.test(foreignRejected.message), foreignRejected && foreignRejected.message);
record('the rejected key was not stored', license.status().keys.length === 1, `${license.status().keys.length} keys`);

// a hardware id pasted in any shape must land in the same key
const messy = mint(['--tier', 'supporter', '--hw', machineId.replace(/-/g, '').toLowerCase()]);
record('a machine id copied without dashes/case still binds',
  license.verify(messy).valid === true && license.verify(messy).payload.h === machineId,
  license.verify(messy).payload.h);

// unbound keys must keep working (giveaways) — they are what --batch produces
const unbound = mint(['--tier', 'supporter']);
record('an unbound key still works (ready for a giveaway)',
  license.verify(unbound).valid === true && !license.verify(unbound).payload.h);

license.deactivate(boundHere);
license.deactivate(messy);
license.deactivate(unbound);
record('the store is clean again', license.status().keys.length === 0 && license.tier() === 'free');

fs.rmSync(dataRoot, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== ${results.length - failed}/${results.length} licence checks passed ===`);
process.exit(failed ? 1 : 0);
