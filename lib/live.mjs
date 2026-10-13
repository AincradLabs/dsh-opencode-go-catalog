// lib/live.mjs — Live-Mitgliedschaft: Roster holen, Modelle automatisch
// den drei Sibling-Routen zuordnen.
//
// VORGESCHICHTE: Der Snapshot (catalog/models.json) war kuratiert, weil kein
// Endpoint das Protokoll nennt — neue Modelle mussten von Hand triagiert
// werden. Mit dem Protokoll-Orakel (lib/protocols.mjs) faellt dieser Grund
// weg: die Doku-Tabelle nennt fuer jede gelistete ID das Protokoll.
//
// MODELL DER AUTO-MITGLIEDSCHAFT
//   Mitglied = Live-Roster  ∩  Registry-Metadaten  ∩  Protokoll bekannt
//              \ Veto-Liste (snapshot.excluded / deliberatelyExcluded)
// Nur live-verifizierte IDs mit beidem kommen rein. Faellt eine ID aus dem
// Roster (Modell abgekuendigt), verschwindet sie beim naechsten Sync von
// selbst — genau das war der Zweck.
//
// SICHERHEITSGURTE (gegen einen kaputten Endpoint oder ein Doku-Redesign):
//   - kein Protokoll  -> nicht einsortieren, sondern unresolved melden
//   - zu wenige IDs   -> Auto-Modus verweigert, Snapshot gilt (minAutoModels)
//   - Kapazitaeten werden NIE erfunden: fehlen sie in der Registry, bleibt ein
//     im Snapshot bereits verifizierter Wert stehen, sonst wird das Feld
//     weggelassen (llm-pi-ai setzt dann seine Routen-Defaults) + needsReview.

import fs from 'node:fs';
import path from 'node:path';
import { mapInput, mapLimits, mapReasoningEfforts } from './reasoning.mjs';

const ROSTER_URL = 'https://opencode.ai/zen/go/v1/models';

// Registry-Eintrag zu einer ID finden (Schluessel sind mal blank, mal
// "opencode-go/<id>"). Identisch zu bin/sync.mjs, damit beide Wege gleich
// aufloesen.
export function findRegistryEntry(models, id) {
  if (!models || typeof models !== 'object') return null;
  if (models[id]) return models[id];
  const hit = Object.keys(models).find((k) => k === `opencode-go/${id}` || k.split('/').pop() === id);
  return hit ? models[hit] : null;
}

// Roster der Go-Modelle (keyless). Cache als Last-Good, wirft nie.
export async function fetchRoster(cfg = {}, { cacheDir, log = () => {} } = {}) {
  const timeoutMs = Math.max(1000, cfg.refreshTimeoutMs ?? 30000);
  const file = cacheDir ? path.join(cacheDir, 'roster.json') : null;
  const readCache = () => {
    try {
      if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* still */ }
    return null;
  };
  const pack = (ids, source) => {
    const set = new Set(ids.filter((x) => typeof x === 'string' && x.length));
    return { ids: set, source };
  };
  try {
    const res = await fetch(ROSTER_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ids = (data?.data ?? []).map((m) => m?.id).filter(Boolean);
    if (ids.length === 0) throw new Error('leere data-Liste');
    try {
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), url: ROSTER_URL, ids }, null, 2) + '\n');
      }
    } catch { /* still */ }
    return pack(ids, 'live');
  } catch (err) {
    const cached = readCache();
    if (cached?.ids?.length) {
      log(`Roster: ${err?.message ?? err} — Last-Good-Cache gilt (${cached.ids.length} IDs)`);
      return pack(cached.ids, 'cache-fallback');
    }
    log(`Roster: ${err?.message ?? err} — kein Cache, Auto-Modus nicht moeglich`);
    return { ids: null, source: 'failed', error: String(err?.message ?? err) };
  }
}

// Baut die drei Routen frisch aus der Live-Lage.
// snapshot liefert nur noch die Routen-Definitionen (api/baseURL/displayName),
// die Veto-Liste und die zuletzt verifizierten Kapazitaeten als Rueckfall.
export function buildAutoCatalog({ snapshot, registryModels, roster, protocols, cfg = {} }) {
  const routeDefs = snapshot?.routes ?? {};
  const minAutoModels = Math.max(1, cfg.minAutoModels ?? 8);
  const stats = { members: 0, perRoute: {}, added: [], removed: [], unresolved: [], vetoed: [], needsReview: [], reusedLimits: [] };

  // Veto-Liste: Schluessel mit "_" sind Kommentare (z. B. "_hinweis").
  const vetoKeys = (obj) => Object.keys(obj ?? {}).filter((k) => !k.startsWith('_'));
  const vetoed = new Set([...vetoKeys(snapshot?.excluded), ...vetoKeys(snapshot?.deliberatelyExcluded)]);
  const routeByApi = new Map(Object.entries(routeDefs).map(([name, rec]) => [rec.api, name]));
  const snapshotLimits = new Map();
  const snapshotIds = new Set();
  for (const rec of Object.values(routeDefs)) {
    for (const m of rec.models ?? []) {
      snapshotIds.add(m.id);
      if (Number.isInteger(m.contextWindow) && Number.isInteger(m.maxTokens)) {
        snapshotLimits.set(m.id, { contextWindow: m.contextWindow, maxTokens: m.maxTokens });
      }
    }
  }

  const built = Object.fromEntries(Object.keys(routeDefs).map((name) => [name, []]));
  for (const id of roster ?? []) {
    if (vetoed.has(id)) { stats.vetoed.push(id); continue; }
    const api = protocols?.[id];
    if (!api) { stats.unresolved.push(`${id}: kein Protokoll in der Doku-Tabelle`); continue; }
    const route = routeByApi.get(api);
    if (!route) { stats.unresolved.push(`${id}: Protokoll ${api} hat keine verwaltete Route`); continue; }
    const entry = findRegistryEntry(registryModels, id);
    if (!entry) { stats.unresolved.push(`${id}: keine Registry-Metadaten (Name/Limits unbekannt)`); continue; }

    // Nur ein Eintrag pro ID: die Doku-Zeile ist die Wahrheit, doppelte
    // Roster-Nennungen werden ignoriert.
    if (built[route].some((m) => m.id === id)) continue;
    if (Object.values(built).some((list) => list.some((m) => m.id === id))) {
      stats.unresolved.push(`${id}: mehrdeutige Protokoll-Angabe — uebersprungen`);
      continue;
    }

    const limits = mapLimits(entry) ?? snapshotLimits.get(id) ?? null;
    const model = { id, name: entry.name ?? id };
    if (limits) {
      model.contextWindow = limits.contextWindow;
      model.maxTokens = limits.maxTokens;
      if (!mapLimits(entry)) { model.needsReview = true; stats.reusedLimits.push(id); }
    } else {
      model.needsReview = true;
    }
    model.input = mapInput(entry);
    const efforts = mapReasoningEfforts(entry);
    if (efforts !== undefined) model.reasoningEfforts = efforts;
    if (model.needsReview) stats.needsReview.push(id);
    built[route].push(model);
  }

  // Deterministische Reihenfolge (alphabetisch): eine neue oder sterbende ID
  // verschiebt damit nicht die Positionen aller anderen im Picker.
  const routes = {};
  for (const [name, rec] of Object.entries(routeDefs)) {
    const models = built[name].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    routes[name] = { ...rec, models };
    stats.perRoute[name] = models.length;
    stats.members += models.length;
  }

  for (const id of snapshotIds) {
    if (!Object.values(routes).some((r) => r.models.some((m) => m.id === id))) stats.removed.push(id);
  }
  for (const rec of Object.values(routes)) {
    for (const m of rec.models) if (!snapshotIds.has(m.id)) stats.added.push(m.id);
  }
  stats.added.sort();
  stats.removed.sort();

  if (stats.members < minAutoModels) {
    return { ok: false, reason: `nur ${stats.members} Modelle mit bekanntem Protokoll (< minAutoModels=${minAutoModels}) — Snapshot gilt`, stats };
  }
  return { ok: true, routes, stats };
}
