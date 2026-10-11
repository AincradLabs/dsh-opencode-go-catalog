// dsh-opencode-go-catalog — Host-Modul.
//
// Was es tut:
//   Schreibt den Snapshot aus catalog/models.json als drei Sibling-Routen
//   (opencode-go-extras / -responses / -messages) in den llm-pi-ai-Namespace,
//   über die offizielle settings.mutate-Naht. Die eingebaute opencode-go-Route
//   wird NIE angefasst (sie spannt drei Protokolle; ein models:-Override dort
//   würde sie zerbrechen).
//
// Was es NICHT tut:
//   Nie node_modules editieren, nie Secrets loggen/schreiben, nie beim Boot
//   werfen (degradiert zu Warnung + manueller YAML-Anleitung).
//
// Toggle:
//   enabled:false (config oder Settings-Namespace) -> Sibling-Routen werden
//   wieder entfernt. disabled:true auf der Bundle-Row -> Plugin lädt gar nicht.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapReasoningEfforts, mapInput, mapLimits } from './reasoning.mjs';

const BUILTIN_ROUTE = 'opencode-go';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');

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
    startupDelaySeconds: 5,
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

// Holt das Live-Registry (ETag-Cache + Last-Good-Datei als Fallback).
// Gibt { models } zurück oder null (dann gelten die Snapshot-Werte).
// Wirft nie — Netzwerkfehler sind normal (Offline, Timeout) und bedeuten
// nur: diesmal gelten die Datei-Werte.
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
      if (hit) { info('registry: 304 — Cache gilt'); return hit['opencode-go']?.models ?? null; }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    try {
      fs.writeFileSync(bodyFile, JSON.stringify(data));
      const newEtag = res.headers.get('etag');
      if (newEtag) fs.writeFileSync(etagFile, newEtag);
    } catch { /* still */ }
    return data['opencode-go']?.models ?? data?.providers?.['opencode-go']?.models ?? null;
  } catch (err) {
    const fallback = readCache();
    if (fallback) {
      warn(`registry: ${err?.message ?? err} — Last-Good-Cache gilt`);
      return fallback['opencode-go']?.models ?? null;
    }
    warn(`registry: ${err?.message ?? err} — Snapshot-Werte gelten`);
    return null;
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

// Schreibt change-only: vorhandene Sibling-Routen bleiben unangetastet, wenn
// sie bereits identisch sind. Gibt { ok, via, changed } zurück.
async function mutateSiblings(ctx, fragment, { remove = false } = {}) {
  const settings = ctx?.settings;
  if (!settings || typeof settings.mutate !== 'function') {
    return { ok: false, via: 'none', reason: 'settings.mutate fehlt (Host zu alt oder Namespace anders gemountet)' };
  }
  let changed = [];
  await settings.mutate((doc) => {
    const next = doc ?? {};
    const ns = (next['llm-pi-ai'] ??= {});
    const providers = (ns.providers ??= {});
    for (const [route, rec] of Object.entries(fragment)) {
      if (route === BUILTIN_ROUTE) continue; // Sicherheitsgurt: eingebaute Route nie schreiben
      if (remove) {
        if (route in providers) { delete providers[route]; changed.push(`-${route}`); }
        continue;
      }
      const prev = JSON.stringify(providers[route] ?? null);
      if (prev !== JSON.stringify(rec)) { providers[route] = rec; changed.push(`~${route}`); }
    }
    return next;
  });
  return { ok: true, via: 'settings.mutate', changed };
}

function manualYamlHint(catalog) {
  const lines = [
    '# Falls der Host-Schreibweg fehlt: diesen Block VON HAND in die',
    '# llm-pi-ai.providers-Sektion (cordis.patch.yml / settings.yaml) übernehmen.',
    '# opencode-go selbst dabei UNVERÄNDERT lassen!',
  ];
  for (const [route, rec] of Object.entries(catalog.routes)) {
    lines.push(`    ${route}:`);
    lines.push(`      apiKeyEnv: OPENCODE_GO_API_KEY`);
    lines.push(`      displayName: ${rec.displayName}`);
    lines.push(`      api: ${rec.api}`);
    lines.push(`      baseURL: ${rec.baseURL}`);
    lines.push(`      models: # ${rec.models.length} Modelle, siehe catalog/models.json`);
    for (const m of rec.models) lines.push(`        - id: ${m.id}`);
  }
  return lines.join('\n');
}

async function syncOnce(ctx, cfg, reason) {
  const { info, warn } = logger(ctx);
  const t0 = Date.now();
  try {
    const catalog = loadCatalog(resolveCatalogPath(cfg.catalogPath));
    if (cfg.enabled && cfg.refreshReasoning !== false) {
      const live = await refreshRegistry(ctx, cfg);
      const touched = mergeFreshFields(catalog, live);
      if (touched) info(`sync(${reason}): ${touched} Feld-Updates aus Live-Registry`);
    }
    const fragment = buildProvidersFragment(catalog);
    // Nur gemanagte Routen schreiben, nie mehr.
    const wanted = Object.fromEntries(
      Object.entries(fragment).filter(([r]) => cfg.managedRoutes.includes(r)),
    );
    if (!cfg.enabled) {
      const res = await mutateSiblings(ctx, wanted, { remove: true });
      info(`sync(${reason}): deaktiviert -> Sibling-Routen entfernt`, res.changed?.join(' ') || '(keine Änderung)');
      return res;
    }
    const res = await mutateSiblings(ctx, wanted);
    if (!res.ok) {
      warn(`sync(${reason}): Host-Schreibweg fehlt (${res.reason}). Manueller Weg:\n${manualYamlHint(catalog)}`);
      return res;
    }
    const total = Object.values(wanted).reduce((n, r) => n + (r.models?.length ?? 0), 0);
    info(`sync(${reason}): ${total} Modelle auf ${Object.keys(wanted).length} Routen (${res.changed.join(' ') || 'unverändert'}) in ${Date.now() - t0}ms`);
    return res;
  } catch (err) {
    warn(`sync(${reason}) fehlgeschlagen: ${err?.message ?? err} — eingebaute Route läuft weiter, nichts kaputtgeschrieben.`);
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

function tryRegisterCommand(ctx, cfg, run) {
  // Die Command-Registry ist ein optionales Peer — ohne sie laufen nur die
  // geplanten Runden (graceful degrade, kein Fehler).
  try {
    const reg = ctx?.commands ?? ctx?.commandRegistry ?? null;
    if (reg && typeof reg.register === 'function') {
      reg.register('opencode-go-sync', 'OpenCode-Go-Siblings aus catalog/models.json neu schreiben', run);
      return 'commands.register';
    }
    if (typeof ctx?.command === 'function') {
      ctx.command('opencode-go-sync', 'OpenCode-Go-Siblings neu schreiben', run);
      return 'ctx.command';
    }
  } catch { /* still */ }
  return null;
}

async function tryRegisterSettingsNamespace(ctx, cfg) {
  // Eigener Namespace für den UI-Toggle. Optional: ohne @deepseek-ai/dsh-settings
  // bleibt die Datei-Config (cordis.patch.yml) die Quelle der Wahrheit.
  try {
    const mod = await import('@deepseek-ai/dsh-settings').catch(() => null);
    const schemastery = await import('@deepseek-ai/schemastery').catch(() => null);
    if (!mod || typeof ctx?.settings?.register !== 'function') return null;
    const z = schemastery?.default ?? schemastery;
    const schema = z?.object
      ? z.object({
          enabled: z.boolean().default(true),
          intervalMinutes: z.number().step(1).min(0).default(240),
        })
      : null;
    const ns = mod.settingsNamespace?.('opencode-go-catalog') ?? 'opencode-go-catalog';
    await ctx.settings.register(ns, schema ?? {}, {});
    return ns;
  } catch {
    return null;
  }
}

export async function apply(ctx, config = {}) {
  const { info, warn } = logger(ctx);
  const cfg = asConfig(config);
  try {
    const ns = await tryRegisterSettingsNamespace(ctx, cfg);
    if (ns) info(`Settings-Namespace registriert: ${ns} (Toggle: enabled)`);

    await syncOnce(ctx, cfg, 'startup');

    const cmd = tryRegisterCommand(ctx, cfg, () => syncOnce(ctx, cfg, 'command'));
    if (cmd) info(`Kommando registriert: /opencode-go-sync (via ${cmd})`);

    if ((cfg.intervalMinutes ?? 0) > 0) {
      const ms = cfg.intervalMinutes * 60_000;
      const timer = setInterval(() => { syncOnce(ctx, cfg, 'interval'); }, ms);
      try { timer.unref?.(); } catch { /* still */ }
      info(`Intervall-Sync alle ${cfg.intervalMinutes}min aktiv (0 = nur beim Start)`);
    }
    return { ok: true };
  } catch (err) {
    // Fail-safe: ein Katalog-Plugin darf den Host-Start nie verhindern.
    warn(`Start degradiert: ${err?.message ?? err}`);
    return { ok: false, degraded: true };
  }
}

export default { apply };
