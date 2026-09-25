'use strict';
/**
 * Monetisation surface that works with ZERO infrastructure on your side.
 *
 * Everything in here is data-driven from resources/monetization.json and can be
 * overridden by a file with the same name in the user data directory (handy for
 * white-labelling). No telemetry, no server calls, no accounts required.
 *
 * The three channels that need no domain and no website:
 *   1. licence keys      -> sold via any hosted checkout (see tools/keygen.js)
 *   2. hoster affiliate   -> swap the referralUrl placeholders for your own IDs
 *   3. cloud upsell       -> contextual offer when the user's PC-bound server hurts
 */
const { getDirs, bundledResourcesDir } = require('../core/paths');
const { readJSON, createLogger } = require('../core/util');
const settings = require('../core/settings');
const license = require('./license');

const log = createLogger('monetize');

const DEFAULTS = {
  currency: 'EUR',
  supporter: {
    enabled: true,
    price: '25',
    priceLabelKey: 'monetize.supporter.price',
    // Replace with your own checkout link (Gumroad / Lemon Squeezy / Ko-fi / Stripe payment link).
    // Until then the button opens the built-in "how to get a key" dialog.
    checkoutUrl: null,
    email: null
  },
  hosters: [
    {
      id: 'hetzner',
      name: 'Hetzner Cloud',
      url: 'https://www.hetzner.com/cloud',
      referralUrl: null,
      priceFrom: '€4.59/mo',
      spec: 'CX22 · 2 vCPU · 4 GB · 24/7',
      highlight: true
    },
    {
      id: 'netcup',
      name: 'netcup',
      url: 'https://www.netcup.com/en/server/vps',
      referralUrl: null,
      priceFrom: '€3.99/mo',
      spec: 'VPS 1000 · 24/7'
    },
    {
      id: 'bisecthosting',
      name: 'BisectHosting',
      url: 'https://www.bisecthosting.com/minecraft-server-hosting',
      referralUrl: null,
      priceFrom: '€2.99/mo',
      spec: 'Managed Minecraft hosting'
    },
    {
      id: 'zap',
      name: 'ZAP-Hosting',
      url: 'https://zap-hosting.com/en/minecraft-server-hosting/',
      referralUrl: null,
      priceFrom: '€3.00/mo',
      spec: 'Managed Minecraft hosting'
    }
  ],
  upsells: {
    cloudAfterStarts: 3,       // offer "24/7 cloud server" after N server starts
    tunnelAfterDays: 2,        // offer the tunnel once a server exists for N days
    nudgeCooldownHours: 48
  },
  docs: {
    affiliateNote: 'Set referralUrl on any hoster entry to turn these cards into affiliate revenue.',
    licenseNote: 'Sell keys with tools/keygen.js and any hosted checkout — no website needed.'
  }
};

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let cache = null;

function config() {
  if (cache) return cache;
  const bundled = readJSON(`${bundledResourcesDir()}/monetization.json`, null);
  const user = readJSON(`${getDirs().root}/monetization.json`, null);
  cache = deepMerge(deepMerge(DEFAULTS, bundled), user);
  return cache;
}

function reload() {
  cache = null;
  return config();
}

function affiliateUrl(hoster) {
  return hoster.referralUrl || hoster.url;
}

function info() {
  const cfg = config();
  const lic = license.status();
  return {
    currency: cfg.currency,
    supporter: {
      ...cfg.supporter,
      active: lic.tier !== 'free',
      tier: lic.tier,
      canSell: true
    },
    hosters: cfg.hosters.map((h) => ({ ...h, openUrl: affiliateUrl(h), isAffiliate: !!h.referralUrl })),
    docs: cfg.docs,
    showCards: settings.get('showUpsellCards', true)
  };
}

/** Track engagement locally (never sent anywhere) to time upsells fairly. */
function noteServerStart() {
  const count = (settings.get('instanceCountStarted', 0) || 0) + 1;
  settings.set({ instanceCountStarted: count });
  return count;
}

function nudgeState() {
  return settings.get('nudgeState', {}) || {};
}

function _nudgeAllowed(feature) {
  const cfg = config();
  if (!settings.get('showSupporterNudge', true)) return false;
  const state = nudgeState();
  const last = state[feature] ? new Date(state[feature]).getTime() : 0;
  const cooldown = (cfg.upsells.nudgeCooldownHours || 48) * 3600 * 1000;
  return Date.now() - last > cooldown;
}

function markNudged(feature) {
  const state = { ...nudgeState(), [feature]: new Date().toISOString() };
  settings.set({ nudgeState: state });
  return state;
}

/**
 * Decide which contextual upsell (if any) to show.
 * @returns {{feature:string, kind:string, headline:string, body:string}|null}
 */
function suggestUpsell({ instanceCount = 0, onlineCount = 0 } = {}) {
  const cfg = config();
  const lic = license.status();

  if (lic.tier === 'free' && instanceCount >= 1) {
    const starts = settings.get('instanceCountStarted', 0) || 0;
    if (starts >= (cfg.upsells.cloudAfterStarts || 3) && _nudgeAllowed('cloud')) {
      return {
        feature: 'cloud',
        kind: 'hoster',
        headline: 'Keep it online 24/7',
        body: `Your server has been started ${starts} times. If your PC has to stay on for friends to play, a small cloud box (~${cfg.hosters[0].priceFrom}) runs it around the clock — you keep the same dashboard.`
      };
    }
    if (_nudgeAllowed('tunnel')) {
      return {
        feature: 'tunnel',
        kind: 'license',
        headline: 'Play together without port forwarding',
        body: 'Open a tunnel so friends can join through a simple address — no router setup, no port forwarding, works behind CGNAT.'
      };
    }
  }
  return null;
}

function dismiss(kind) {
  const state = { ...nudgeState(), [`dismissed:${kind}`]: new Date().toISOString() };
  settings.set({ nudgeState: state });
  return true;
}

module.exports = { DEFAULTS, config, reload, info, affiliateUrl, noteServerStart, suggestUpsell, markNudged, dismiss };
