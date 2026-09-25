#!/usr/bin/env node
'use strict';
/**
 * Licence key tooling — this is how you actually make money without a website.
 *
 *  1) Create the signing keypair once:
 *       node tools/keygen.js --keygen
 *     -> writes keys/mcss-private.pem (KEEP SECRET, never commit)
 *     -> prints the public key to paste into src/main/licensing/license.js
 *
 *  2) Mint a key whenever somebody buys one (Gumroad/Ko-fi/Lemon Squeezy auto
 *     delivery or a manual message), then just send them the string:
 *       node tools/keygen.js --mint --tier supporter --name "Max M." --email max@example.com
 *       node tools/keygen.js --mint --tier cloud --days 365 --name "Community X"
 *
 *  3) Verify a key someone sent you:
 *       node tools/keygen.js --verify MCSS1-xxxx.yyyy
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEYS_DIR = path.resolve(__dirname, '..', 'keys');
const PRIVATE_KEY_FILE = path.join(KEYS_DIR, 'mcss-private.pem');
const PUBLIC_KEY_FILE = path.join(KEYS_DIR, 'mcss-public.txt');

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function args() {
  const out = { _: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i += 1; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function keygen() {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const pubB64 = Buffer.from(pubDer).toString('base64');

  fs.writeFileSync(PRIVATE_KEY_FILE, privPem, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_FILE, `${pubB64}\n`);

  console.log('Keypair created.');
  console.log(`  private key : ${PRIVATE_KEY_FILE}   <-- NEVER commit or share this`);
  console.log(`  public key  : ${PUBLIC_KEY_FILE}`);
  console.log('\nPaste this into src/main/licensing/license.js as PUBLIC_KEY_B64:\n');
  console.log(pubB64);
  console.log('\n(Then rebuild the app. Keys minted with the matching private key will verify.)');
}

function loadPrivate() {
  if (!fs.existsSync(PRIVATE_KEY_FILE)) {
    console.error(`No private key at ${PRIVATE_KEY_FILE}. Run: node tools/keygen.js --keygen`);
    process.exit(2);
  }
  return crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_FILE, 'utf8'));
}

function mint(opts) {
  const tier = opts.tier || 'supporter';
  const days = opts.days ? Number(opts.days) : null;
  const payload = {
    v: 1,
    t: tier,
    n: opts.name || null,
    e: opts.email || null,
    i: new Date().toISOString(),
    x: days ? new Date(Date.now() + days * 86400000).toISOString() : (opts.expires || null),
    k: opts.kid || 'default'
  };
  const payloadBuf = Buffer.from(b64u(Buffer.from(JSON.stringify(payload))));
  const signature = crypto.sign(null, payloadBuf, loadPrivate());
  const key = `MCSS1-${b64u(Buffer.from(JSON.stringify(payload)))}.${b64u(signature)}`;
  console.log(`\nTier      : ${tier}`);
  console.log(`Name      : ${payload.n || '-'}`);
  console.log(`Email     : ${payload.e || '-'}`);
  console.log(`Expires   : ${payload.x || 'never'}`);
  console.log('\nLICENCE KEY (send this to the customer):\n');
  console.log(key);
  console.log('');
}

function verify(key) {
  const body = key.replace(/^MCSS1-/, '');
  const [p, s] = body.split('.');
  const payload = JSON.parse(fromB64u(p).toString('utf8'));
  const pubB64 = fs.existsSync(PUBLIC_KEY_FILE) ? fs.readFileSync(PUBLIC_KEY_FILE, 'utf8').trim() : null;
  if (!pubB64) { console.error('No public key file found.'); process.exit(2); }
  const pub = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
  const ok = crypto.verify(null, Buffer.from(p), pub, fromB64u(s));
  console.log(JSON.stringify({ valid: ok, payload }, null, 2));
  process.exit(ok ? 0 : 1);
}

const a = args();
if (a.keygen) keygen();
else if (a.mint) mint(a);
else if (a.verify) verify(a._[0] || a.verify);
else {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).join('\n').replace(/^\/\*\*?|\s\*\/?/gm, ''));
}
