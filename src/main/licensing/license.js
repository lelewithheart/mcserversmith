'use strict';
/**
 * Offline-verifiable licence keys (Ed25519) — monetisation without a website.
 *
 * Why this design: the app must be sellable BEFORE any domain/website exists.
 * Keys are signed offline with a private key (tools/keygen.js) and verified on
 * the client with an embedded public key. That means you can sell keys through
 * *any* hosted checkout (Gumroad, Lemon Squeezy, Ko-fi, a Discord shop, a
 * manual PayPal invoice) — no server, no domain, no monthly infrastructure.
 *
 * Key format:  MCSS1-<base64url(payload json)>.<base64url(signature)>
 * Payload:     { v, t: tier, n: name, e: email, i: issued, x: expires, k: key id }
 *
 * An online activation endpoint can be configured later (licenseServerUrl) for
 * revocation lists; it is entirely optional.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDirs } = require('../core/paths');
const { readJSON, writeJSON, createLogger } = require('../core/util');

const log = createLogger('license');

/** Production public key — replace by running `npm run keygen`. */
const PUBLIC_KEY_B64 = process.env.MCSERVERSMITH_LICENSE_PUBKEY || 'MCowBQYDK2VwAyEAERSvnBp2djxGMeJdiWaOL0RKJq2aC2rypjp9FY0n2Fk=';

const TIERS = {
  free: {
    label: 'Free',
    features: []
  },
  supporter: {
    label: 'Supporter',
    features: [
      'tunnel',            // managed tunnel / no port forwarding
      'autoRestart',       // watchdog restarts a crashed server
      'scheduledRestarts', // nightly restarts + auto-backup
      'autoBackups',       // interval backups with retention
      'branding'           // MOTD/favicon quick tools
    ]
  },
  cloud: {
    label: 'Cloud',
    features: ['tunnel', 'autoRestart', 'scheduledRestarts', 'autoBackups', 'branding', 'cloudHosting']
  }
};

// ---------------------------------------------------------------------------
function b64uDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isPlaceholder(key) {
  return !key || key.includes('PLACEHOLDER');
}

function publicKeyObject() {
  if (isPlaceholder(PUBLIC_KEY_B64)) return null;
  try {
    return crypto.createPublicKey({
      key: Buffer.from(PUBLIC_KEY_B64, 'base64'),
      format: 'der',
      type: 'spki'
    });
  } catch (err) {
    log.error(`embedded public key is invalid: ${err.message}`);
    return null;
  }
}

function parseKey(key) {
  const trimmed = String(key || '').trim();
  const body = trimmed.startsWith('MCSS1-') ? trimmed.slice(6) : trimmed;
  const [payloadB64, sigB64] = body.split('.');
  if (!payloadB64 || !sigB64) throw new Error('Key format looks wrong (expected MCSS1-… . …)');
  let payload;
  try {
    payload = JSON.parse(b64uDecode(payloadB64).toString('utf8'));
  } catch {
    throw new Error('Key payload is not readable');
  }
  return { payload, signature: b64uDecode(sigB64) };
}

function verify(key) {
  const { payload, signature } = parseKey(key);

  // dev mode: no production key embedded yet -> accept a locally minted key
  if (isPlaceholder(PUBLIC_KEY_B64)) {
    const devKey = readJSON(path.join(getDirs().root, 'dev-license-pubkey.json'), null);
    if (!devKey || !devKey.publicKey) {
      return { valid: false, reason: 'No production key is embedded in this build and no developer key was found.' };
    }
    const okDev = crypto.verify(
      null,
      Buffer.from(b64uEncode(Buffer.from(JSON.stringify(payload)))),
      crypto.createPublicKey(devKey.publicKey),
      signature
    );
    if (!okDev) return { valid: false, reason: 'Signature does not match the developer key.' };
  } else {
    const pub = publicKeyObject();
    const ok = crypto.verify(
      null,
      Buffer.from(b64uEncode(Buffer.from(JSON.stringify(payload)))),
      pub,
      signature
    );
    if (!ok) return { valid: false, reason: 'Invalid signature — this key was not issued by MCServerSmith.' };
  }

  if (payload.x) {
    const exp = new Date(payload.x).getTime();
    if (Number.isFinite(exp) && exp < Date.now()) {
      return { valid: false, reason: `This key expired on ${payload.x}`, payload };
    }
  }
  if (!TIERS[payload.t]) return { valid: false, reason: `Unknown tier "${payload.t}"`, payload };

  return { valid: true, payload, tier: payload.t };
}

// ---------------------------------------------------------------------------
function loadStore() {
  const file = getDirs().licenses;
  const data = readJSON(file, null);
  if (!data || !Array.isArray(data.keys)) return { keys: [], updatedAt: null };
  return data;
}

function saveStore(store) {
  store.updatedAt = new Date().toISOString();
  writeJSON(getDirs().licenses, store);
  return store;
}

function activeEntries() {
  const store = loadStore();
  const out = [];
  for (const entry of store.keys) {
    const res = verify(entry.key);
    if (res.valid) out.push({ ...entry, tier: res.tier, payload: res.payload });
  }
  // highest tier wins
  const rank = { free: 0, supporter: 1, cloud: 2 };
  out.sort((a, b) => rank[b.tier] - rank[a.tier]);
  return out;
}

function devMode() {
  return process.env.MCSERVERSMITH_DEV_LICENSE === '1';
}

function tier() {
  if (devMode()) return 'cloud';
  const act = activeEntries();
  return act.length ? act[0].tier : 'free';
}

function features() {
  const t = tier();
  return (TIERS[t] && TIERS[t].features) || [];
}

function hasFeature(name) {
  return features().includes(name);
}

/** Throws a structured error when a paid feature is used without a licence. */
function requireFeature(name) {
  if (hasFeature(name)) return true;
  const err = new Error(`"${name}" is a supporter feature`);
  err.code = 'LICENSE_REQUIRED';
  err.feature = name;
  throw err;
}

function activate(key, { label = null } = {}) {
  const res = verify(key);
  if (!res.valid) throw new Error(res.reason || 'Invalid licence key');
  const store = loadStore();
  const dup = store.keys.find((k) => k.key === String(key).trim());
  if (!dup) {
    store.keys.push({
      key: String(key).trim(),
      label,
      addedAt: new Date().toISOString()
    });
    saveStore(store);
  }
  log.info(`licence activated: tier=${res.tier}`);
  return status();
}

function deactivate(key) {
  const store = loadStore();
  store.keys = store.keys.filter((k) => k.key !== String(key).trim());
  saveStore(store);
  return status();
}

function status() {
  const act = activeEntries();
  const t = tier();
  return {
    tier: t,
    label: (TIERS[t] && TIERS[t].label) || t,
    devMode: devMode(),
    features: features(),
    allFeatures: Object.fromEntries(Object.entries(TIERS).map(([k, v]) => [k, v.features])),
    keys: loadStore().keys.map((k) => {
      const v = verify(k.key);
      return {
        label: k.label,
        addedAt: k.addedAt,
        valid: v.valid,
        reason: v.reason || null,
        tier: v.tier || null,
        name: v.payload ? v.payload.n : null,
        expires: v.payload ? v.payload.x : null,
        preview: `${String(k.key).slice(0, 12)}…${String(k.key).slice(-6)}`
      };
    }),
    publicKeyEmbedded: !isPlaceholder(PUBLIC_KEY_B64)
  };
}

/** Write the developer keypair so a placeholder build is usable in dev. */
function installDevKeypair({ publicKeyPem }) {
  writeJSON(path.join(getDirs().root, 'dev-license-pubkey.json'), { publicKey: publicKeyPem });
  return true;
}

module.exports = {
  TIERS,
  PUBLIC_KEY_B64,
  verify,
  activate,
  deactivate,
  status,
  tier,
  features,
  hasFeature,
  requireFeature,
  installDevKeypair,
  b64uEncode,
  b64uDecode,
  isPlaceholder
};
