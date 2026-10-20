// dsh-opencode-go-catalog — Host-Modul.
//
// Was es tut:
//   Schreibt drei Sibling-Routen (opencode-go-extras / -responses / -messages)
//   in den llm-pi-ai-Namespace, über den offiziellen settings-Seam:
//   mutate('llm-pi-ai', ops) mit Pfad-Ops
//   ({op:'set'|'unset', path:['providers', route]}). Die eingebaute
//   opencode-go-Route wird NIE angefasst. Quellen der Routen:
//     - AUTO (Default): Live-Roster (welche IDs es jetzt gibt) + Protokoll-
//       Orakel aus der Doku-Endpoint-Tabelle (welches Wire-Protokoll) +
//       Registry (Name/Limits/Modalitäten/reasoning_options). Neue Modelle
//       erscheinen ohne Handarbeit, abgekündigte fallen raus.
//     - SNAPSHOT (Rückfall, und bei autoMembership:false): catalog/models.json.
//   Scheitert Roster oder Orakel, gilt der Snapshot weiter — ein Netzausfall
//   darf den Picker nie leeren.
//
// WICHTIG für Handarbeit (verifiziert 2026-10-13):
//   settings.mutate persistiert in die Profil-Patchdatei (cordis.patch.yml),
//   und jede Sibling-Route wird als GANZES Objekt gesetzt. Ein von Hand (oder
//   über Settings -> Models) hinzugefügtes Modell in einer dieser Routen ist
//   damit beim nächsten Sync weg — Startup, Intervall, /opencode-go-sync.
//   Dauerhafte Einträge gehören in den Snapshot (bin/sync.mjs --adopt) oder in
//   die Veto-Liste; der Auto-Modus zieht sie sonst aus der Live-Lage.
//
// Belegte Host-APIs (gegen DSH 0.2.0-rc.2 Quellen verifiziert):
//   - ctx.inject(['settings'], (scoped) => ...) — EINZIGER Weg an den Service;
//     direkter Zugriff (ctx.settings) ist im Plugin-Fiber-Scope leer
//   - scoped.settings.describe() -> [{ns, revision, ...}], ns = Entry-id
//   - scoped.settings.mutate(ns, ops, expectedRevision?) — nur volatile Felder;
//     `providers` ist im llm-pi-ai-Schema volatile (ganzer Dict)
//   - ctx.inject(['commands'], (scoped) => ...),
 //     scoped.commands.register({name, description, handler}) — Objektform!
//     WICHTIG: registriert wird über ctx.root (globaler Layer, für alle
//     Agents sichtbar). Über den Plugin-Fiber-ctx landet die Definition
//     außerhalb jeder Agent-Scope-Chain: Selbst-Probe grün, UI-Menü leer.
//   - llm-pi-ai hört auf loader/volatile-update und registriert Routen neu
//   - Fiber-Effect-Regel (cordis safeCollect): apply() löst NUR void auf —
//     ein Objekt als Rückgabe wirft "TypeError: Invalid effect".
//
// Toggle:
//   enabled:false (eigene Patch-Row mit VOLLER config, siehe cordis.patch.yml)
//   -> Sibling-Routen werden wieder entfernt (unset-Op).
//   disabled:true auf der Bundle-Row -> Plugin lädt gar nicht.
// Diagnose: nach jedem Sync-Versuch liegt PKG_ROOT/status.json (Zeit, ok,
// via, changed, command, fetch, auto{members,added,removed,unresolved}, error)
// — im Editor lesbar, ohne Log-Zugang.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapReasoningEfforts, mapInput, mapLimits } from './reasoning.mjs';
import { fetchProtocolTable } from './protocols.mjs';
import { fetchRoster, buildAutoCatalog, findRegistryEntry } from './live.mjs';

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
    // Auto-Mitgliedschaft (2026-10-13): Mitglieder werden bei JEDEM Sync frisch
    // aus Live-Roster + Protokoll-Orakel (Doku-Endpoint-Tabelle) gebaut. Neue
    // Go-Modelle erscheinen damit ohne Handarbeit im Picker, abgekündigte
    // fallen automatisch raus. false -> alter kuratierter Snapshot-Weg.
    // ACHTUNG: Der Auto-Modus BRAUCHT das Registry (Name/Limits/Modalitäten).
    // refreshReasoning:false heißt "kein Netz" und schaltet ihn daher mit ab.
    autoMembership: true,
    minAutoModels: 8, // Sicherheitsgurt: darunter gilt der Snapshot (fail-safe)
    minAutoRatio: 0.6, // Gurt gegen eine degradierte (nicht tote) Quelle; 0 = aus
    minProtocolRows: 10, // Sicherheitsgurt gegen ein Doku-Redesign
    // Statischer x-opencode-session-Header auf allen Sibling-Routen (Default an):
    // Das Gateway verlangt ihn seit 09/05, pi-ai hängt ihn aber nur an die
    // KATALOG-Routen (opencode-go.js-Provider-Modul) — hand-deklarierte Routen
    // werden "from parts" ohne den Wrapper gebaut und bekämen sonst 400
    // MissingSessionID. Trade-off (User-belegt): EINE feste ID für alle
    // Conversations -> weniger Cache-Hits -> langsamer/teurer. Abschalten mit
    // false; sobald der Adapter sessionHeader (pro Conversation) lernt, fliegt
    // das hier ersatzlos raus. Eigener String als Wert ist erlaubt.
    sessionHeaderValue: 'dsh-opencode-go-catalog',
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

// Service-Zugriff NUR über ctx.inject([...]) — direkter Zugriff (ctx.settings)
// ist im Plugin-Fiber-Scope leer (Scratch-Boot 2026-10-11 belegt: Naht fehlte,
// obwohl der Service läuft). Muster belegt durch dshmarket + llm-pi-ai.
// Versucht sofortigen Zugriff UND hängt den inject-Hook ein (Service kann
// später mounten); onReady feuert für jeden gefundenen Service genau einmal.
// Sichtbarkeits-Nachweis für status.json: welche Naht auf welchem Weg
// erreicht wurde (direkt/inject). Beantwortet "läuft apply, sieht aber keine
// Services?" ohne Log-Zugang.
const SEAM = { settingsDirect: false, settingsInject: false, commandsDirect: false, commandsInject: false, cmdVia: null };

function hookService(ctx, key, onReady) {
  const seen = new Set();
  const grab = (scope, viaInject) => {
    try {
      const svc = scope?.[key] ?? (typeof scope?.get === 'function' ? scope.get(key) : null) ?? null;
      if (svc && !seen.has(svc)) {
        seen.add(svc);
        SEAM[key + (viaInject ? 'Inject' : 'Direct')] = true;
        onReady?.(svc);
      }
      return svc;
    } catch { return null; }
  };
  const direct = grab(ctx, false);
  try {
    if (typeof ctx?.inject === 'function') ctx.inject([key], (scoped) => grab(scoped, true));
  } catch { /* still */ }
  return direct;
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

// Mischt fresh Registry-Felder in den Katalog: input/Limits/reasoningEfforts
// pro Modell. Mitgliedschaft und Routen-Zuordnung bleiben kuratiert — das ist
// der SNAPSHOT-Weg (Rückfall und autoMembership:false); im Auto-Modus baut
// lib/live.mjs die Routen komplett neu.
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
// `routes` ist entweder catalog.routes (Snapshot-Weg) oder das Ergebnis von
// buildAutoCatalog (Live-Weg) — die Form ist identisch.
function buildProvidersFragment(routes, cfg = {}) {
  const providers = {};
  const staticHeader = cfg.sessionHeaderValue !== false && cfg.sessionHeaderValue != null
    ? { 'x-opencode-session': String(cfg.sessionHeaderValue) }
    : null;
  for (const [route, rec] of Object.entries(routes)) {
    // Nie eine Route ohne Modelle schreiben: llm-pi-ai lehnt "resolves no
    // models" ab, und weil alle Routen in EINER mutate-Op-Liste stehen, würde
    // eine leere Gruppe auch die gesunden blockieren. Lieber diese Route
    // unangetastet lassen (die vorherige Konfiguration gilt weiter) — der
    // Aufrufer meldet die Auslassung in status.json.
    if (!rec.models?.length) continue;
    providers[route] = {
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      displayName: rec.displayName ?? route,
      api: rec.api,
      baseURL: rec.baseURL,
      ...(staticHeader ? { headers: staticHeader } : {}),
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
    return { ok: false, via: 'none', changed: [], retryable: true, reason: 'settings-Seam fehlt (inject-Callback nie gefeuert?)' };
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

async function syncOnce(ctx, cfg, reason, settings) {
  const { info, warn } = logger(ctx);
  const t0 = Date.now();
  const status = { time: new Date().toISOString(), reason, enabled: cfg.enabled !== false, seam: { ...SEAM } };
  try {
    const catalog = loadCatalog(resolveCatalogPath(cfg.catalogPath));
    if (cfg.enabled === false) {
      const res = await mutateSiblings(settings, {}, cfg.managedRoutes, { remove: true });
      status.ok = res.ok; status.via = res.via; status.changed = res.changed;
      if (!res.ok && res.reason) status.error = res.reason;
      info(`sync(${reason}): deaktiviert -> Sibling-Routen entfernt`, (res.changed ?? []).join(' ') || (res.ok ? '(keine Änderung)' : res.reason));
      writeStatus(status);
      return { ...res, status };
    }
    let fetchSource = 'snapshot';
    let liveModels = null;
    if (cfg.refreshReasoning !== false) {
      const live = await refreshRegistry(ctx, cfg);
      fetchSource = live.source;
      liveModels = live.models;
    }

    // AUTO-MITGLIEDSCHAFT: Routen frisch aus Live-Roster + Protokoll-Orakel.
    // Scheitert einer der beiden Wege, gilt der Snapshot unverändert weiter —
    // ein Netzausfall oder ein Doku-Redesign darf den Picker nie leeren.
    // refreshReasoning:false heißt "kein Netz" und schaltet den Auto-Modus mit
    // ab (er braucht die Registry-Metadaten) — sonst würde der Schalter
    // stillschweigend zwei Endpunkte anfassen und den Auto-Modus lahmlegen.
    let routes = catalog.routes;
    if (cfg.autoMembership !== false && cfg.refreshReasoning !== false) {
      const cacheDir = path.resolve(PKG_ROOT, 'catalog', '.cache');
      const roster = await fetchRoster(cfg, { cacheDir, log: info });
      const oracle = await fetchProtocolTable(cfg, { cacheDir, roster: roster.ids, log: info });
      status.auto = { roster: roster.source, protocols: oracle.source };
      // Protokoll aus dem Cache, weil die Doku die ID nicht mehr listet:
      // zweithändig, aber belegt -> sichtbar machen statt still übernehmen.
      if (oracle.carried?.length) status.auto.carried = oracle.carried;
      // Degradiertes Orakel ist eine WARNUNG, keine Randnotiz: es hält den
      // Picker am Leben (Cache/Snapshot), verschweigt aber jedes NEUE Modell.
      // Genau so blieb minimax-m3.1-flash-free nach dem v2-Doku-Umbau unsichtbar.
      if (oracle.degraded) {
        status.auto.degraded = true;
        status.auto.protocolsUrl = oracle.finalUrl ?? null;
        warn(`Protokoll-Orakel degradiert (${oracle.source}, ${oracle.parsedRows ?? '?'} Zeilen live) —`
          + ' neue Go-Modelle erscheinen NICHT im Picker. Doku-Format prüfen:'
          + ` ${oracle.finalUrl ?? 'https://opencode.ai/docs/go/'}`);
      }
      if (roster.ids && oracle.table) {
        const auto = buildAutoCatalog({ snapshot: catalog, registryModels: liveModels, roster: roster.ids, protocols: oracle.table, cfg });
        Object.assign(status.auto, {
          ok: auto.ok,
          reason: auto.ok ? undefined : auto.reason,
          members: auto.stats.members,
          perRoute: auto.stats.perRoute,
          added: auto.stats.added,
          removed: auto.stats.removed,
          unresolved: auto.stats.unresolved,
          vetoed: auto.stats.vetoed,
          needsReview: auto.stats.needsReview,
          reusedLimits: auto.stats.reusedLimits,
          carried: auto.stats.carried,
          snapshotRoutes: auto.stats.snapshotRoutes,
          notes: auto.stats.notes,
          conflicts: oracle.conflicts ?? [],
        });
        if (auto.ok) {
          routes = auto.routes;
          fetchSource = `${fetchSource}+auto`;
          const perRoute = Object.entries(auto.stats.perRoute).map(([r, n]) => `${r.replace('opencode-go-', '')}:${n}`).join(' ');
          info(`sync(${reason}): auto ${auto.stats.members} Modelle (${perRoute})`
            + (auto.stats.added.length ? ` | neu: ${auto.stats.added.join(', ')}` : '')
            + (auto.stats.removed.length ? ` | weg: ${auto.stats.removed.join(', ')}` : '')
            + (auto.stats.snapshotRoutes.length ? ` | aus Snapshot: ${auto.stats.snapshotRoutes.join(', ')}` : '')
            + (auto.stats.unresolved.length ? ` | unklar: ${auto.stats.unresolved.length}` : ''));
        } else {
          info(`sync(${reason}): Auto-Modus verweigert — ${auto.reason}; Snapshot gilt`);
        }
      } else {
        status.auto.ok = false;
        status.auto.reason = !roster.ids
          ? `Roster nicht verfügbar (${roster.error ?? roster.source})`
          : `Protokoll-Tabelle nicht verfügbar (${oracle.error ?? oracle.source})`;
        info(`sync(${reason}): Auto-Modus aus — ${status.auto.reason}; Snapshot gilt`);
      }
    } else if (cfg.autoMembership !== false) {
      status.auto = { ok: false, reason: 'refreshReasoning:false — Auto-Modus braucht das Registry, Snapshot gilt' };
      info(`sync(${reason}): Auto-Modus aus (refreshReasoning:false); Snapshot gilt`);
    }

    // Snapshot-Weg (oder Auto verweigert): Felder im Snapshot frisch ziehen.
    if (routes === catalog.routes && liveModels) {
      const touched = mergeFreshFields(catalog, liveModels);
      if (touched) info(`sync(${reason}): ${touched} Feld-Updates aus Live-Registry (${fetchSource})`);
    }
    status.fetch = fetchSource;
    const fragment = buildProvidersFragment(routes, cfg);
    // Ausgelassene Routen sichtbar machen (leerer models-Array): sie behalten
    // ihre vorherige Konfiguration, statt den ganzen Schreibvorgang zu kippen.
    const omitted = cfg.managedRoutes.filter((route) => !fragment[route]);
    if (omitted.length) {
      status.omittedRoutes = omitted;
      warn(`sync(${reason}): Route(n) ohne Modelle übersprungen: ${omitted.join(', ')} — vorherige Konfiguration bleibt stehen`);
    }
    const res = await mutateSiblings(settings, fragment, cfg.managedRoutes);
    status.ok = res.ok; status.via = res.via; status.changed = res.changed;
    if (!res.ok) {
      status.error = res.reason; status.retryable = res.retryable;
      warn(`sync(${reason}): Host-Schreibweg fehlt (${res.reason}). Manueller Weg:\n${manualYamlHint({ routes })}`);
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

function registerCommandNow(reg, ctx, cfg, getSettings, via = 'commands.register') {
  // Objektform nach dsh-commands-Referenz, gespiegelt am working Producer
  // dsh-plan-mode (definitionId wie dort; zur Laufzeit nur ein String).
  // Danach Selbst-Probe: find/list müssen die Definition liefern — sonst ist
  // die Registrierung in einer Scope gelandet, die kein Adapter abfragt.
  try {
    if (reg && typeof reg.register === 'function') {
      reg.register({
        definitionId: 'dsh-opencode-go-catalog/opencode-go-sync',
        name: 'opencode-go-sync',
        description: 'Rewrite OpenCode Go sibling routes from the catalog snapshot',
        handler: async () => {
          const res = await syncOnce(ctx, cfg, 'command', getSettings());
          const changed = (res.status?.changed ?? []).join(' ') || 'unverändert';
          return res.ok
            ? { kind: 'success', text: `opencode-go-sync: ok (${changed}, fetch: ${res.status?.fetch ?? '?'})` }
            : { kind: 'error', text: `opencode-go-sync: FEHLER — ${res.status?.error ?? res.reason ?? 'unbekannt'}. Siehe status.json im Plugin-Ordner.` };
        },
      });
      SEAM.cmdVia = via;
      try {
        const found = reg.find?.(undefined, 'opencode-go-sync') ?? reg.find?.(null, 'opencode-go-sync') ?? null;
        let count = null;
        let names = null;
        try {
          const all = reg.list?.(undefined) ?? reg.list?.(null) ?? null;
          if (Array.isArray(all)) { count = all.length; names = all.map((d) => d?.name); }
        } catch { /* still */ }
        SEAM.cmdProbe = {
          found: !!found,
          foundName: found?.name ?? null,
          listCount: count,
          names,
        };
      } catch (e) {
        SEAM.cmdProbe = { error: String(e?.message ?? e) };
      }
      return via;
    }
  } catch { /* still */ }
  return null;
}

// Löst den commands-Dienst über einen Basis-ctx auf (direkt oder per inject)
// und reicht die aufgelöste Instanz an cb weiter. Kehrt sofort zurück; das
// inject-Callback kann später feuern.
function resolveCommandsService(baseCtx, cb) {
  if (!baseCtx) return;
  let direct = null;
  try { direct = baseCtx.commands ?? (typeof baseCtx.get === 'function' ? baseCtx.get('commands') : null) ?? null; } catch { /* still */ }
  if (direct) { cb(direct); return; }
  try {
    if (typeof baseCtx.inject === 'function') baseCtx.inject(['commands'], (scoped) => cb(scoped?.commands ?? scoped ?? null));
  } catch { /* still */ }
}

export async function apply(ctx, config = {}) {
  const { info, warn } = logger(ctx);
  const cfg = asConfig(config);
  // NUR Fiber-void zurückgeben (cordis safeCollect): niemals ein Objekt!
  const box = { settings: null, commands: null, cmdVia: null, booted: false };
  const getSettings = () => box.settings;
  const boot = async (reason) => {
    const res = await syncOnce(ctx, cfg, reason, getSettings());
    if (!res.ok && res.retryable) {
      for (const wait of [15000, 15000, 30000]) {
        await new Promise((r) => setTimeout(r, wait));
        const retry = await syncOnce(ctx, cfg, 'retry', getSettings());
        if (retry.ok || !retry.retryable) break;
      }
    }
    return res;
  };
  const kick = (why) => { boot(why).catch((e) => warn(`Sync(${why}): ${e?.message ?? e}`)); };
  try {
    box.settings = hookService(ctx, 'settings', (svc) => {
      box.settings = svc;
      info('settings-Service via inject erreicht — Sync angestoßen');
      kick('inject');
    });
    // Command-Registrierung: PRIMÄR über ctx.root. Belegt im Scratch-Boot
    // 2026-10-11: Eine Registrierung über den Plugin-Fiber-ctx landet
    // außerhalb jeder Agent-Scope-Chain — die Selbst-Probe findet sie
    // (listCount 1), aber /api/commands/list für Session-Agents enthält sie
    // nie, und der Effekt wird später entsorgt. Über ctx.root landet sie in
    // der globalen Schicht und ist für alle Agents sichtbar (dort sofort in
    // commands/list verifiziert). Fiber-ctx bleibt nur Fallback für Hosts
    // ohne root.
    const rootCtx = ctx && ctx.root && ctx.root !== ctx ? ctx.root : null;
    SEAM.cmdRoot = { hasRoot: !!rootCtx };
    const onCommands = (svc, via) => {
      if (!svc) return;
      if (!box.commands) box.commands = svc;
      if (!box.cmdVia) {
        box.cmdVia = registerCommandNow(svc, ctx, cfg, getSettings, via);
        if (box.cmdVia) info(`Kommando registriert: /opencode-go-sync (via ${box.cmdVia})`);
      }
    };
    if (rootCtx) resolveCommandsService(rootCtx, (svc) => onCommands(svc, 'commands.register/root'));
    hookService(ctx, 'commands', (svc) => onCommands(svc, 'commands.register/fiber'));
    if (!box.commands) {
      // Direktversuch (falls Registry schon da, aber inject später feuert):
      box.cmdVia = registerCommandNow(box.commands, ctx, cfg, getSettings, 'commands.register/direct');
    }
    if (!box.cmdVia) info('Command-Registry noch nicht erreicht — /opencode-go-sync wird nachregistriert, sobald sie da ist');

    const delayMs = Math.max(0, (cfg.startupDelaySeconds ?? 0) * 1000);
    setTimeout(() => kick('startup'), delayMs);
    info(`Boot-Sync in ${Math.round(delayMs / 1000)}s geplant`);

    if ((cfg.intervalMinutes ?? 0) > 0) {
      const ms = cfg.intervalMinutes * 60_000;
      const timer = setInterval(() => { kick('interval'); }, ms);
      try { timer.unref?.(); } catch { /* still */ }
      info(`Intervall-Sync alle ${cfg.intervalMinutes}min aktiv (0 = nur beim Start)`);
    }
    return;
  } catch (err) {
    // Fail-safe: ein Katalog-Plugin darf den Host-Start nie verhindern.
    warn(`Start degradiert: ${err?.message ?? err}`);
    try { writeStatus({ time: new Date().toISOString(), reason: 'apply', ok: false, error: String(err?.message ?? err) }); } catch { /* still */ }
    return;
  }
}

export default { apply };
