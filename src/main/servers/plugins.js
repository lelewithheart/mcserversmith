'use strict';
/**
 * Plugin / mod browser + one-click installer.
 * Sources: Modrinth (open API) and PaperMC Hangar (open API).
 * SpigotMC has no public API and scraping it violates their terms — so we don't.
 */
const path = require('path');
const fs = require('fs');
const { fetchJSON, download } = require('../core/http');
const { createLogger, ensureDir, exists, humanBytes, rmrf } = require('../core/util');
const instances = require('./instances');

const log = createLogger('plugins');

const MODRINTH = 'https://api.modrinth.com/v2';
const HANGAR = 'https://hangar.papermc.io/api/v1';

/** Which folder do addons live in, and which loaders are relevant? */
function folderFor(meta) {
  const kind = meta.kind;
  if (kind === 'plugin' || kind === 'proxy') return { dir: 'plugins', projectType: 'plugin' };
  if (kind === 'modded') return { dir: 'mods', projectType: 'mod' };
  return null;
}

/** Map our provider ids to Modrinth loader tags. */
function modrinthLoaders(meta) {
  const map = {
    paper: ['paper', 'bukkit', 'spigot'],
    purpur: ['purpur', 'paper', 'bukkit', 'spigot'],
    folia: ['folia', 'paper', 'bukkit', 'spigot'],
    spigot: ['spigot', 'bukkit'],
    velocity: ['velocity'],
    fabric: ['fabric', 'quilt'],
    forge: ['forge'],
    neoforge: ['neoforge']
  };
  return map[meta.provider] || [meta.provider];
}

function hangarPlatform(meta) {
  const map = { paper: 'PAPER', purpur: 'PURPUR', folia: 'FOLIA', velocity: 'VELOCITY', spigot: 'PAPER' };
  return map[meta.provider] || 'PAPER';
}

// ---------------------------------------------------------------------------
async function searchModrinth({ query, mcVersion, meta, limit = 20 }) {
  const loc = folderFor(meta);
  if (!loc) throw new Error('This server type does not support plugins or mods');
  const facets = [
    [`project_type:${loc.projectType}`],
    [`categories:${modrinthLoaders(meta).join(',')}`]
  ];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  const url = `${MODRINTH}/search?query=${encodeURIComponent(query || '')}`
    + `&limit=${limit}&index=relevance&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const data = await fetchJSON(url);
  return (data.hits || []).map((h) => ({
    source: 'modrinth',
    id: h.project_id,
    slug: h.slug,
    name: h.title,
    description: h.description,
    downloads: h.downloads,
    author: h.author,
    icon: h.icon_url,
    categories: h.categories || [],
    pageUrl: `https://modrinth.com/project/${h.slug}`
  }));
}

async function searchHangar({ query, mcVersion, meta, limit = 20 }) {
  const platform = hangarPlatform(meta);
  let url = `${HANGAR}/projects?limit=${limit}&offset=0&sort=-downloads&q=${encodeURIComponent(query || '')}`;
  if (mcVersion) url += `&version=${encodeURIComponent(mcVersion)}`;
  if (platform) url += `&platform=${platform}`;
  const data = await fetchJSON(url);
  const rows = data.result || data.projects || [];
  return rows.map((p) => ({
    source: 'hangar',
    id: p.namespace ? `${p.namespace.owner}/${p.namespace.slug}` : p.id,
    slug: p.namespace ? p.namespace.slug : p.id,
    name: p.name,
    description: p.description,
    downloads: (p.stats && p.stats.downloads) || 0,
    author: p.namespace ? p.namespace.owner : null,
    icon: p.avatarUrl || null,
    categories: p.category ? [p.category] : [],
    pageUrl: p.namespace ? `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}` : null
  }));
}

async function search({ source = 'modrinth', query, mcVersion, meta, limit = 20 }) {
  if (source === 'hangar') return searchHangar({ query, mcVersion, meta, limit });
  return searchModrinth({ query, mcVersion, meta, limit });
}

// ---------------------------------------------------------------------------
async function versions({ source = 'modrinth', id, meta, mcVersion, limit = 20 }) {
  if (source === 'hangar') {
    const [owner, slug] = String(id).includes('/') ? String(id).split('/') : [null, id];
    if (!owner) throw new Error('Hangar needs "owner/slug"');
    const platform = hangarPlatform(meta);
    const url = `${HANGAR}/projects/${owner}/${slug}/versions?limit=${limit}&offset=0`
      + (platform ? `&platform=${platform}` : '')
      + (mcVersion ? `&version=${encodeURIComponent(mcVersion)}` : '');
    const data = await fetchJSON(url);
    return (data.result || []).map((v) => {
      const dl = v.downloads || {};
      const platformEntry = dl[platform] || Object.values(dl)[0] || {};
      const info = platformEntry.fileInfo || {};
      return {
        source: 'hangar',
        versionId: String(v.id),
        name: v.name,
        channel: (v.channel && v.channel.name) || null,
        downloadUrl: platformEntry.downloadUrl || platformEntry.fileUrl || null,
        filename: info.name || `${slug}-${v.name}.jar`,
        size: info.sizeBytes || null,
        hashes: { sha256: info.sha256Hash || null },
        gameVersions: [],
        loaders: [platform],
        versionType: (v.channel && v.channel.name) || 'release',
        pageUrl: `https://hangar.papermc.io/${owner}/${slug}/versions/${v.name}`
      };
    });
  }

  const params = [];
  const loaders = modrinthLoaders(meta);
  params.push(`loaders=${encodeURIComponent(JSON.stringify(loaders))}`);
  if (mcVersion) params.push(`game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`);
  const data = await fetchJSON(`${MODRINTH}/project/${encodeURIComponent(id)}/version?${params.join('&')}`);
  return (data || []).map((v) => {
    const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0] || {};
    return {
      source: 'modrinth',
      versionId: v.id,
      name: v.name || v.version_number,
      channel: v.version_type,
      downloadUrl: file.url || null,
      filename: file.filename || `${String(id).slice(0, 8)}.jar`,
      size: file.size || null,
      hashes: { sha512: file.hashes && file.hashes.sha512, sha1: file.hashes && file.hashes.sha1 },
      gameVersions: v.game_versions || [],
      loaders: v.loaders || [],
      versionType: v.version_type,
      pageUrl: `https://modrinth.com/project/${id}/version/${v.version_number}`
    };
  });
}

// ---------------------------------------------------------------------------
function addonDir(id) {
  const meta = instances.read(id);
  const loc = folderFor(meta);
  if (!loc) throw new Error('This server type does not support plugins/mods');
  const p = instances.instancePaths(id);
  return { dir: path.join(p.server, loc.dir), name: loc.dir, meta };
}

function installedAddons(id) {
  const { dir, name } = addonDir(id);
  if (!exists(dir)) return { folder: name, files: [] };
  const files = fs.readdirSync(dir)
    .filter((f) => /\.jar(\.disabled)?$/i.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, bytes: st.size, modifiedAt: st.mtime.toISOString(), disabled: f.endsWith('.disabled') };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { folder: name, files, sizeBytes: files.reduce((a, f) => a + f.bytes, 0) };
}

/**
 * Download one addon into plugins/ or mods/.
 */
async function install(manager, id, { downloadUrl, filename, hashes = null, onProgress = null }) {
  const { dir, name } = addonDir(id);
  ensureDir(dir);
  const target = path.join(dir, path.basename(filename || 'addon.jar'));
  await download(downloadUrl, target, { hashes, onProgress });
  log.info(`installed ${path.basename(target)} into ${name}/ for ${id}`);
  return { path: target, folder: name, filename: path.basename(target), bytes: fs.statSync(target).size };
}

function removeAddon(id, filename) {
  const { dir } = addonDir(id);
  const target = path.join(dir, path.basename(filename));
  if (!exists(target)) throw new Error(`${filename} not found`);
  rmrf(target);
  return true;
}

function toggleAddon(id, filename) {
  const { dir } = addonDir(id);
  const target = path.join(dir, path.basename(filename));
  if (!exists(target)) throw new Error(`${filename} not found`);
  const isDisabled = target.endsWith('.disabled');
  const next = isDisabled ? target.replace(/\.disabled$/, '') : `${target}.disabled`;
  fs.renameSync(target, next);
  return { name: path.basename(next), disabled: !isDisabled };
}

module.exports = {
  folderFor,
  search,
  versions,
  install,
  installedAddons,
  removeAddon,
  toggleAddon,
  humanBytes
};
