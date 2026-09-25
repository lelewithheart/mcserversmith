'use strict';
/**
 * UPnP IGD port forwarding — the "just works" path for players on the same
 * public IP / NAT, with no domain, no tunnel service and no monthly cost.
 *
 * Discovery is plain SSDP (UDP multicast), the mapping is a SOAP call.
 * Everything here is best effort: plenty of routers have UPnP disabled, and
 * CGNAT (DS-Lite / carrier NAT) cannot be helped at all — in that case we say so
 * clearly instead of pretending.
 */
const dgram = require('dgram');
const http = require('http');
const https = require('https');
const os = require('os');
const { URL } = require('url');
const { createLogger } = require('../core/util');

const log = createLogger('upnp');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

function localIPv4() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) candidates.push({ name, address: a.address });
    }
  }
  // prefer typical LAN ranges
  const lan = candidates.find((c) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(c.address));
  return (lan || candidates[0] || null)?.address || null;
}

function ssdpSearch(timeoutMs = 2500, st = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1') {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const results = [];
    socket.on('error', () => { try { socket.close(); } catch { /* ignore */ } resolve(results); });
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const loc = text.match(/LOCATION:\s*(\S+)/i);
      if (loc) results.push({ location: loc[1].trim(), from: rinfo.address });
    });
    socket.bind(() => {
      try { socket.setBroadcast(true); } catch { /* ignore */ }
      const payload = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n'
        + `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n`
        + 'MAN: "ssdp:discover"\r\n'
        + 'MX: 2\r\n'
        + `ST: ${st}\r\n\r\n`
      );
      socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_ADDR, () => { /* ignore */ });
    });
    setTimeout(() => {
      try { socket.close(); } catch { /* ignore */ }
      resolve(results);
    }, timeoutMs);
  });
}

function httpGetText(url, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function httpSoap(url, serviceType, action, bodyXml, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const envelope = '<?xml version="1.0"?>\n'
      + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
      + 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
      + `<s:Body><u:${action} xmlns:u="${serviceType}">${bodyXml}</u:${action}></s:Body></s:Envelope>`;
    const req = mod.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      timeout,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(envelope),
        SOAPAction: `"${serviceType}#${action}"`,
        Connection: 'close'
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c.toString(); });
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`SOAP ${res.statusCode}: ${data.slice(0, 200)}`));
        else resolve(data);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(envelope);
  });
}

/** Find an IGD control endpoint + service type. */
async function discoverGateway({ timeoutMs = 2500 } = {}) {
  const replies = await ssdpSearch(timeoutMs);
  if (!replies.length) {
    const alt = await ssdpSearch(timeoutMs, 'urn:schemas-upnp-org:service:WANIPConnection:1');
    replies.push(...alt);
  }
  if (!replies.length) return null;

  for (const reply of replies) {
    let xml;
    try {
      xml = await httpGetText(reply.location);
    } catch { continue; }
    const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => m[1]);
    const wanted = services.find((s) => /WANIPConnection|WANPPPConnection/i.test(s));
    if (!wanted) continue;
    const typeMatch = wanted.match(/<serviceType>([^<]+)<\/serviceType>/i);
    const ctrlMatch = wanted.match(/<controlURL>([^<]+)<\/controlURL>/i);
    if (!typeMatch || !ctrlMatch) continue;
    const controlUrl = new URL(ctrlMatch[1].trim(), reply.location).toString();
    return { controlUrl, serviceType: typeMatch[1].trim(), location: reply.location, localIp: localIPv4() };
  }
  return null;
}

function isCgnat(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4) return false;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

async function getExternalIp(gw) {
  try {
    const xml = await httpSoap(gw.controlUrl, gw.serviceType, 'GetExternalIPAddress', '');
    const m = xml.match(/<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/i);
    return m ? m[1] : null;
  } catch (err) {
    log.warn(`GetExternalIPAddress failed: ${err.message}`);
    return null;
  }
}

async function addMapping(gw, { port, internalIp, protocol = 'TCP', description = 'MCServerSmith', lease = 0 }) {
  const body = [
    '<NewRemoteHost></NewRemoteHost>',
    `<NewExternalPort>${port}</NewExternalPort>`,
    `<NewProtocol>${protocol}</NewProtocol>`,
    `<NewInternalPort>${port}</NewInternalPort>`,
    `<NewInternalClient>${internalIp}</NewInternalClient>`,
    '<NewEnabled>1</NewEnabled>',
    `<NewPortMappingDescription>${String(description).replace(/[<>&]/g, '')}</NewPortMappingDescription>`,
    `<NewLeaseDuration>${lease}</NewLeaseDuration>`
  ].join('');
  await httpSoap(gw.controlUrl, gw.serviceType, 'AddPortMapping', body);
  return true;
}

async function deleteMapping(gw, { port, protocol = 'TCP' }) {
  const body = `<NewRemoteHost></NewRemoteHost><NewExternalPort>${port}</NewExternalPort><NewProtocol>${protocol}</NewProtocol>`;
  await httpSoap(gw.controlUrl, gw.serviceType, 'DeletePortMapping', body);
  return true;
}

// ---------------------------------------------------------------------------
const activeMappings = [];

/**
 * @returns {Promise<{ok:boolean, reason?:string, externalIp?:string, address?:string, protocols?:string[]}>}
 */
async function forward(port, description = 'MCServerSmith') {
  const internalIp = localIPv4();
  if (!internalIp) return { ok: false, reason: 'no local IPv4 address found' };

  const gw = await discoverGateway();
  if (!gw) return { ok: false, reason: 'no UPnP router found (UPnP may be disabled)' };

  const externalIp = await getExternalIp(gw);
  if (externalIp && isCgnat(externalIp)) {
    return {
      ok: false,
      reason: 'your router sits behind carrier-grade NAT (CGNAT) — port forwarding cannot work here, use a tunnel instead',
      externalIp
    };
  }

  const protocols = [];
  for (const proto of ['TCP', 'UDP']) {
    try {
      await addMapping(gw, { port, internalIp, protocol: proto, description });
      protocols.push(proto);
    } catch (err) {
      log.warn(`AddPortMapping ${proto} failed: ${err.message}`);
    }
  }
  if (!protocols.length) return { ok: false, reason: 'the router refused the port mapping request' };

  activeMappings.push({ port, gateway: gw, protocols });
  return {
    ok: true,
    internalIp,
    externalIp: externalIp || null,
    protocols,
    address: externalIp ? `${externalIp}:${port}` : null
  };
}

async function remove(port) {
  const entry = activeMappings.find((m) => m.port === port);
  if (!entry) return false;
  for (const proto of entry.protocols) {
    try { await deleteMapping(entry.gateway, { port, protocol: proto }); } catch { /* ignore */ }
  }
  const idx = activeMappings.indexOf(entry);
  activeMappings.splice(idx, 1);
  return true;
}

module.exports = { forward, remove, discoverGateway, localIPv4, isCgnat, ssdpSearch };
