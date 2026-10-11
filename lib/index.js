// dsh-opencode-go-catalog — Host-Modul.
//
// Was es tut:
//   Schreibt den Snapshot aus catalog/models.json als drei Sibling-Routen
//   (opencode-go-extras / -responses / -messages) in den llm-pi-ai-Namespace,
//   über den offiziellen settings-Seam: mutate('llm-pi-ai', ops) mit
//   Pfad-Ops ({op:'set'|'unset', path:['providers', route]}). Die eingebaute
//   opencode-go-Route wird NIE angefasst (sie spannt drei Protokolle; ein
//   models:-Override dort würde sie zerbrechen).
//
// Belegte Host-APIs (gegen DSH 0.2.0-rc.2 Quellen verifiziert):
//   - ctx.settings.describe() -> [{ns, revision, ...}], ns = Entry-id
//   - ctx.settings.mutate(ns, ops, expectedRevision?) — nur volatile Felder;
//     `providers` ist im llm-pi-ai-Schema volatile (ganzer Dict)
//   - ctx.commands.register({name, description, handler}) — Objektform!
//   - llm-pi-ai hört auf loader/volatile-update und registriert Routen neu
//
// Toggle:
//   enabled:false (eigene Patch-Row mit VOLLER config, siehe cordis.patch.yml)
//   -> Sibling-Routen werden wieder entfernt (unset-Op).
//   disabled:true auf der Bundle-Row -> Plugin lädt gar nicht.
// Diagnose: nach jedem Sync-Versuch liegt PKG_ROOT/status.json (Zeit, ok,
// via, changed, command, fetch, error) — im Editor lesbar, ohne Log-Zugang.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapReasoningEfforts, mapInput, mapLimits } from './reasoning.mjs';

const BUILTIN_ROUTE = 'opencode-go';
const ADAPTER_NS = 'llm-pi-ai';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const STATUS_FILE = path.join(PKG_ROOT, 'status.json');

function logger(ctx) {
  const info = (...a) => { try { (ctx?.log?.info ?? console.log)('[opencode-go-catalog]', ...a); } catch { /* still */ } };
  const warn = (...a) => { try { (ctx?.log?.warn ?? console.warn)('[opencode-go-catalog]', ...a); } catch { /* still */ } };
  return { info, warn };
}

function asConfig(config = {}) {
  return {
    enabled: true,
    refreshReasoning: true, // input/limits/reasoningEfforts bei jedem Sync fresh aus dem Registry
    intervalMinutes: 240,
    startupDelaySeconds: 10, // Adapter braucht Vorlauf (llm-pi-ai muss gemountet sein)
    refreshTimeoutMs: 120000,
    catalogPath: './catalog/models.json',
    managedRoutes: ['opencode-go-extras', 'opencode-go-responses', 'opencode-go-messages'],
    ...config,
  };
}

function resolveCatalogPath(catalogPath) {
  if (path.isAbsolute(catalogPath)) return catalogPath;
  return path.resolve(PKG_ROOT, catalogPath);
}

function loadCatalog(catalogFile) {
  const raw = fs.readFileSync(catalogFile, 'utf8');
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== 'object' || !doc.routes) throw new Error('catalog/models.json: Feld "routes" fehlt');
  return doc;
}

function settingsService(ctx) {
  try {
    return ctx?.settings ?? ctx?.get?.('settings') ?? null;
  } catch { return null; }
}

function commandsService(ctx) {
  try {
    return ctx?.commands ?? ctx?.get?.('commands') ?? null;
  } catch { return null; }
}

// Holt das Live-Registry (ETag-Cache + Last-Good-Datei als Fallback).
// Gibt { models, source } zurück; models=null heißt: Snapshot-Werte gelten.
// Wirft nie — Netzwerkfehler sind normal und bedeuten nur Datei-Werte.
async function refreshRegistry(ctx, cfg) {
  const { info, warn } = logger(ctx);
  const cacheDir = path.resolve(PKG_ROOT, 'catalog', '.cache');
  const bodyFile = path.join(cacheDir, 'registry.json');
  const etagFile = path.join(cacheDir, 'registry.etag');
  const readCache = () => {
    try {
      if (fs.existsSync(bodyFile)) return JSON.parse(fs.readFileSync(bodyFile, 'utf8'));
    } catch { /* still */ }
    return null;
  };
  const pick = (data) => data?.['opencode-go']?.models ?? data?.providers?.['opencode-go']?.models ?? null;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const etag = fs.existsSync(etagFile) ? fs.readFileSync(etagFile, 'utf8').trim() : null;
    const timeout = Math.max(1000, cfg.refreshTimeoutMs ?? 30000);
    const res = await fetch('https://models.opencode.ai/api.json', {
      signal: AbortSignal.timeout(timeout),
      headers: { accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
    });
    if (res.status === 304) {
      const hit = readCache();
      if (hit && pick(hit)) { info('registry: 304 — Cache gilt'); return { models: pick(hit), source: 'cache-304' }; }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    try {
      fs.writeFileSync(bodyFile, JSON.stringify(data));
      const newEtag = res.headers.get('etag');
      if (newEtag) fs.writeFileSync(etagFile, newEtag);
    } catch { /* still */ }
    return { models: pick(data), source: 'live' };
  } catch (err) {
    const fallback = readCache();
    if (fallback && pick(fallback)) {
      warn(`registry: ${err?.message ?? err} — Last-Good-Cache gilt`);
      return { models: pick(fallback), source: 'cache-fallback' };
    }
    warn(`registry: ${err?.message ?? err} — Snapshot-Werte gelten`);
    return { models: null, source: 'snapshot' };
  }
}

function findRegistryEntry(models, id) {
  if (!models || typeof models !== 'object') return null;
  if (models[id]) return models[id];
  const hit = Object.keys(models).find((k) => k === `opencode-go/${id}` || k.split('/').pop() === id);
  return hit ? models[hit] : null;
}

// Mischt fresh Registry-Felder in den Katalog: input/Limits/reasoningEfforts
// pro Modell. Mitgliedschaft und Routen-Zuordnung bleiben kuratiert (kein
// Auto-Einsortieren — Protokoll steht in keinem Endpoint).
function mergeFreshFields(catalog, registryModels) {
  if (!registryModels) return 0;
  let touched = 0;
  for (const rec of Object.values(catalog.routes)) {
    for (const m of rec.models) {
      const entry = findRegistryEntry(registryModels, m.id);
      if (!entry) continue;
      const limits = mapLimits(entry);
      if (limits) {
        if (m.contextWindow !== limits.contextWindow || m.maxTokens !== limits.maxTokens) touched++;
        m.contextWindow = limits.contextWindow;
        m.maxTokens = limits.maxTokens;
        delete m.needsReview;
      }
      const input = mapInput(entry);
      if (JSON.stringify(m.input) !== JSON.stringify(input)) touched++;
      m.input = input;
      const efforts = mapReasoningEfforts(entry);
      const had = JSON.stringify(m.reasoningEfforts ?? null);
      if (efforts === undefined) delete m.reasoningEfforts;
      else m.reasoningEfforts = efforts;
      if (had !== JSON.stringify(m.reasoningEfforts ?? null)) touched++;
      if (entry.name && entry.name !== m.name) { m.name = entry.name; touched++; }
    }
  }
  return touched;
}

// Baut das providers-Fragment für llm-pi-ai. Jede Sibling-Route bekommt
// api + baseURL + models (Pflicht für hand-deklarierte Routen, sonst
// "model needs an api"). apiKeyEnv zeigt auf denselben Key wie die
// eingebaute Route — der Key wird hier nie gelesen/geschrieben.
function buildProvidersFragment(catalog) {
  const providers = {};
  for (const [route, rec] of Object.entries(catalog.routes)) {
    providers[route] = {
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      displayName: rec.displayName ?? route,
      api: rec.api,
      baseURL: rec.baseURL,
      models: rec.models,
    };
  }
  return providers;
}

function describeRevision(settings) {
  try {
    const rows = settings.describe?.() ?? [];
    const row = Array.isArray(rows) ? rows.find((r) => r?.ns === ADAPTER_NS) : null;
    return row?.revision;
  } catch { return undefined; }
}

function isConflictError(err) {
  const msg = String(err?.message ?? err);
  return err?.name === 'SettingsConflictError' || msg.includes('changed since it was read');
}

// Schreibt change-only über mutate(ns, ops): pro Route genau eine set-Op,
// beim Deaktivieren je eine unset-Op. Gibt { ok, via, changed, retryable }.
async function mutateSiblings(settings, fragment, routes, { remove = false } = {}) {
  if (!settings || typeof settings.mutate !== 'function') {
    return { ok: false, via: 'none', changed: [], retryable: true, reason: 'settings-Seam fehlt (Service noch nicht gemountet?)' };
  }
  const ops = [];
  const changed = [];
  if (remove) {
    for (const route of routes) {
      if (route === BUILTIN_ROUTE) continue; // Sicherheitsgurt: eingebaute Route nie schreiben
      ops.push({ op: 'unset', path: ['providers', route] });
      changed.push(`-${route}`);
    }
  } else {
    for (const [route, rec] of Object.entries(fragment)) {
      if (route === BUILTIN_ROUTE) continue; // Sicherheitsgurt
      if (!routes.includes(route)) continue; // nur gemanagte Routen, nie mehr
      ops.push({ op: 'set', path: ['providers', route], value: rec });
      changed.push(`~${route}`);
    }
  }
  if (!ops.length) return { ok: true, via: 'settings.mutate', changed: [], retryable: false };
  const attempt = async (revision) => settings.mutate(ADAPTER_NS, ops, revision);
  try {
    await attempt(describeRevision(settings));
    return { ok: true, via: 'settings.mutate', changed, retryable: false };
  } catch (err) {
    if (isConflictError(err)) {
      try {
        await attempt(describeRevision(settings)); // einmal mit frischer Revision
        return { ok: true, via: 'settings.mutate(retry)', changed, retryable: false };
      } catch (err2) { return { ok: false, via: 'settings.mutate', changed: [], retryable: false, reason: String(err2?.message ?? err2) }; }
    }
    if (String(err?.message ?? err).includes('No configurable plugin entry')) {
      return { ok: false, via: 'settings.mutate', changed: [], retryable: true, reason: 'llm-pi-ai-Entry noch nicht konfigurierbar (Adapter lädt noch?)' };
    }
    return { ok: false, via: 'settings.mutate', changed: [], retryable: false, reason: String(err?.message ?? err) };
  }
}

function manualYamlHint(catalog) {
  const lines = [
    '# Falls der Host-Schreibweg fehlt: diesen Block VON HAND in die',
    '# llm-pi-ai.providers-Sektion (cordis.patch.yml / settings.yaml) übernehmen.',
    '# opencode-go selbst dabei UNVERÄNDERT lassen! (Ganzer Block: node bin/snippet.mjs)',
  ];
  for (const [route, rec] of Object.entries(catalog.routes)) {
    lines.push(`    ${route}: # ${rec.api} @ ${rec.baseURL} — ${rec.models.length} Modelle, Felder siehe catalog/models.json`);
    for (const m of rec.models) lines.push(`        - id: ${m.id}`);
  }
  return lines.join('\n');
}

function writeStatus(record) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({ plugin: 'dsh-opencode-go-catalog', ...record }, null, 2) + '\n');
  } catch { /* still */ }
}

async function syncOnce(ctx, cfg, reason) {
  const { info, warn } = logger(ctx);
  const t0 = Date.now();
  const status = { time: new Date().toISOString(), reason, enabled: cfg.enabled !== false };
  try {
    const catalog = loadCatalog(resolveCatalogPath(cfg.catalogPath));
    if (cfg.enabled === false) {
      const res = await mutateSiblings(settingsService(ctx), {}, cfg.managedRoutes, { remove: true });
      status.ok = res.ok; status.via = res.via; status.changed = res.changed;
      if (!res.ok && res.reason) status.error = res.reason;
      info(`sync(${reason}): deaktiviert -> Sibling-Routen entfernt`, (res.changed ?? []).join(' ') || (res.ok ? '(keine Änderung)' : res.reason));
      writeStatus(status);
      return { ...res, status };
    }
    let fetchSource = 'snapshot';
    if (cfg.refreshReasoning !== false) {
      const live = await refreshRegistry(ctx, cfg);
      fetchSource = live.source;
      const touched = mergeFreshFields(catalog, live.models);
      if (touched) info(`sync(${reason}): ${touched} Feld-Updates aus Live-Registry (${live.source})`);
    }
    status.fetch = fetchSource;
    const fragment = buildProvidersFragment(catalog);
    const res = await mutateSiblings(settingsService(ctx), fragment, cfg.managedRoutes);
    status.ok = res.ok; status.via = res.via; status.changed = res.changed;
    if (!res.ok) {
      status.error = res.reason; status.retryable = res.retryable;
      warn(`sync(${reason}): Host-Schreibweg fehlt (${res.reason}). Manueller Weg:\n${manualYamlHint(catalog)}`);
      writeStatus(status);
      return { ...res, status };
    }
    const wantedRoutes = new Set(cfg.managedRoutes);
    const total = Object.entries(fragment)
      .filter(([route]) => wantedRoutes.has(route))
      .reduce((n, [, r]) => n + (r.models?.length ?? 0), 0);
    status.ms = Date.now() - t0;
    info(`sync(${reason}): ${total} Modelle auf ${cfg.managedRoutes.length} Routen (${res.changed.join(' ') || 'unverändert'}) in ${status.ms}ms`);
    writeStatus(status);
    return { ...res, status };
  } catch (err) {
    status.ok = false; status.error = String(err?.message ?? err);
    warn(`sync(${reason}) fehlgeschlagen: ${status.error} — eingebaute Route läuft weiter, nichts kaputtgeschrieben.`);
    writeStatus(status);
    return { ok: false, retryable: false, reason: status.error, status };
  }
}

function tryRegisterCommand(ctx, cfg) {
  // Objektform nach dsh-commands-Referenz: register({name, description, handler}).
  // Die Registry ist optional — ohne sie laufen nur die geplanten Runden.
  try {
    const reg = commandsService(ctx);
    if (reg && typeof reg.register === 'function') {
      reg.register({
        name: 'opencode-go-sync',
        description: 'Rewrite OpenCode Go sibling routes from the catalog snapshot',
        handler: async () => {
          const res = await syncOnce(ctx, cfg, 'command');
          const changed = (res.status?.changed ?? []).join(' ') || 'unverändert';
          return res.ok
            ? { kind: 'success', text: `opencode-go-sync: ok (${changed}, fetch: ${res.status?.fetch ?? '?'})` }
            : { kind: 'error', text: `opencode-go-sync: FEHLER — ${res.status?.error ?? res.reason ?? 'unbekannt'}. Siehe status.json im Plugin-Ordner.` };
        },
      });
      return 'commands.register';
    }
  } catch { /* still */ }
  return null;
}

export async function apply(ctx, config = {}) {
  const { info, warn } = logger(ctx);
  const cfg = asConfig(config);
  try {
    const cmd = tryRegisterCommand(ctx, cfg);
    if (cmd) info(`Kommando registriert: /opencode-go-sync (via ${cmd})`);
    else info('Keine Command-Registry gefunden — /opencode-go-sync entfällt, geplante Runden laufen trotzdem');

    const boot = async () => {
      const res = await syncOnce(ctx, cfg, 'startup');
      // Naht noch nicht bereit (Adapter lädt später)? Begrenzt nachversuchen.
      if (!res.ok && res.retryable) {
        for (const wait of [15000, 15000, 30000]) {
          await new Promise((r) => setTimeout(r, wait));
          const retry = await syncOnce(ctx, cfg, 'retry');
          if (retry.ok || !retry.retryable) break;
        }
      }
    };
    const delayMs = Math.max(0, (cfg.startupDelaySeconds ?? 0) * 1000);
    setTimeout(() => { boot().catch((e) => warn(`Boot-Sync: ${e?.message ?? e}`)); }, delayMs);
    info(`Boot-Sync in ${Math.round(delayMs / 1000)}s geplant`);

    if ((cfg.intervalMinutes ?? 0) > 0) {
      const ms = cfg.intervalMinutes * 60_000;
      const timer = setInterval(() => { syncOnce(ctx, cfg, 'interval').catch(() => {}); }, ms);
      try { timer.unref?.(); } catch { /* still */ }
      info(`Intervall-Sync alle ${cfg.intervalMinutes}min aktiv (0 = nur beim Start)`);
    }
    return { ok: true };
  } catch (err) {
    // Fail-safe: ein Katalog-Plugin darf den Host-Start nie verhindern.
    warn(`Start degradiert: ${err?.message ?? err}`);
    try { writeStatus({ time: new Date().toISOString(), reason: 'apply', ok: false, error: String(err?.message ?? err) }); } catch { /* still */ }
    return { ok: false, degraded: true };
  }
}

export default { apply };
