// lib/live.mjs — Live-Mitgliedschaft: Roster holen, Modelle automatisch
// den drei Sibling-Routen zuordnen.
//
// VORGESCHICHTE: Der Snapshot (catalog/models.json) war kuratiert, weil kein
// Endpoint das Protokoll nennt — neue Modelle mussten von Hand triagiert
// werden. Mit dem Protokoll-Orakel (lib/protocols.mjs) fällt dieser Grund
// weg: die Doku-Tabelle nennt für jede gelistete ID das Protokoll.
//
// MODELL DER AUTO-MITGLIEDSCHAFT
//   Mitglied = Live-Roster  ∩  Registry-Metadaten  ∩  Protokoll bekannt
//              \ Veto-Liste (snapshot.excluded / deliberatelyExcluded)
// Nur live-verifizierte IDs mit beidem kommen rein. Fällt eine ID aus dem
// Roster (Modell abgekündigt), verschwindet sie beim nächsten Sync von
// selbst — genau das war der Zweck.
//
// SICHERHEITSGURTE (gegen einen kaputten Endpoint oder ein Doku-Redesign):
//   - kein Protokoll  -> nicht einsortieren, sondern unresolved melden
//     AUSNAHME (19.10.2026): fehlt die Zeile nur, weil die Doku das Modell
//     nicht mehr listet (v2-Doku lässt z. B. minimax-m2.7 weg), gilt das im
//     Snapshot bereits verifizierte Protokoll weiter — gemeldet als `carried`.
//     Der Snapshot ist committet, also belastbarer als der flüchtige Cache.
//   - zu wenige IDs   -> Auto-Modus verweigert, Snapshot gilt (minAutoModels)
//   - zu dünne Quelle -> verweigert (minAutoRatio): schützt gegen eine
//     DEGRADIERTE Antwort, die sonst still den halben Picker leert
//   - leere Route     -> aus dem Snapshot bedienen (llm-pi-ai lehnt
//     "resolves no models" ab, und EINE leere Gruppe würde über die
//     gemeinsame mutate-Op-Liste auch die gesunden Gruppen blockieren)
//   - Kapazitäten werden NIE erfunden: fehlen sie in der Registry, bleibt ein
//     im Snapshot bereits verifizierter Wert stehen, sonst wird das Feld
//     weggelassen (llm-pi-ai setzt dann seine Routen-Defaults) + needsReview.

import fs from 'node:fs';
import path from 'node:path';
import { mapInput, mapLimits, mapReasoningEfforts } from './reasoning.mjs';

const ROSTER_URL = 'https://opencode.ai/zen/go/v1/models';

// Registry-Eintrag zu einer ID finden (Schlüssel sind mal blank, mal
// "opencode-go/<id>"). Liegt hier, damit Host-Modul und bin/sync.mjs dieselbe
// Auflösung benutzen statt dreier Kopien.
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
    log(`Roster: ${err?.message ?? err} — kein Cache, Auto-Modus nicht möglich`);
    return { ids: null, source: 'failed', error: String(err?.message ?? err) };
  }
}

// Baut die drei Routen frisch aus der Live-Lage.
// snapshot liefert nur noch die Routen-Definitionen (api/baseURL/displayName),
// die Veto-Liste und die zuletzt verifizierten Kapazitäten als Rückfall.
export function buildAutoCatalog({ snapshot, registryModels, roster, protocols, protocolRejects = null, cfg = {} }) {
  const routeDefs = snapshot?.routes ?? {};
  const minAutoModels = Math.max(1, cfg.minAutoModels ?? 8);
  const minAutoRatio = Number.isFinite(cfg.minAutoRatio) ? cfg.minAutoRatio : 0.6;
  const stats = {
    members: 0, perRoute: {}, added: [], removed: [], unresolved: [],
    vetoed: [], needsReview: [], reusedLimits: [], snapshotRoutes: [], notes: [],
    carried: [], rejected: [],
  };

  // Veto-Liste: Schlüssel mit "_" sind Kommentare (z. B. "_hinweis").
  const vetoKeys = (obj) => Object.keys(obj ?? {}).filter((k) => !k.startsWith('_'));
  const vetoed = new Set([...vetoKeys(snapshot?.excluded), ...vetoKeys(snapshot?.deliberatelyExcluded)]);
  const rejects = new Set(protocolRejects ?? []);
  const routeByApi = new Map();
  for (const [name, rec] of Object.entries(routeDefs)) {
    // Zwei Routen mit demselben api: die spätere gewinnt — das wäre still.
    if (routeByApi.has(rec.api)) stats.notes.push(`Routen ${routeByApi.get(rec.api)} und ${name} teilen api ${rec.api} — nur ${name} wird befüllt`);
    routeByApi.set(rec.api, name);
  }
  const snapshotLimits = new Map();
  const snapshotIds = new Set();
  // Bereits verifiziertes Protokoll je ID (Route -> api). Zweite Quelle für
  // den Fall, dass die Doku eine live vorhandene ID nicht mehr listet.
  const snapshotProtocols = new Map();
  for (const rec of Object.values(routeDefs)) {
    for (const m of rec.models ?? []) {
      snapshotIds.add(m.id);
      if (rec.api) snapshotProtocols.set(m.id, rec.api);
      if (Number.isInteger(m.contextWindow) && Number.isInteger(m.maxTokens)) {
        snapshotLimits.set(m.id, { contextWindow: m.contextWindow, maxTokens: m.maxTokens });
      }
    }
  }

  const built = Object.fromEntries(Object.keys(routeDefs).map((name) => [name, []]));
  const seen = new Set();
  for (const id of roster ?? []) {
    if (seen.has(id)) { stats.unresolved.push(`${id}: doppelt im Roster`); continue; }
    seen.add(id);
    if (vetoed.has(id)) { stats.vetoed.push(id); continue; }
    let api = protocols?.[id] ?? null;
    let carried = false;
    // Vom Live-Parser BEWUSST verworfen (URL/SDK-Widerspruch): der Snapshot darf
    // die ID nicht per Carry-over zurückholen — sonst stünde in status.json
    // gleichzeitig der Konflikt und das widersprochene Protokoll im Picker
    // (Review-Befund B1).
    if (!api && rejects.has(id)) {
      stats.rejected.push(id);
      stats.unresolved.push(`${id}: Protokoll in der Live-Doku widersprüchlich (URL vs SDK) — bewusst nicht übernommen`);
      continue;
    }
    if (!api && snapshotProtocols.has(id)) {
      // Die Doku listet die ID nicht mehr, der Snapshot hat sie aber schon
      // einmal belegt einsortiert. Kein Raten (keine Heuristik), aber
      // zweithändig — deshalb gemeldet.
      api = snapshotProtocols.get(id);
      carried = true;
    }
    if (!api) { stats.unresolved.push(`${id}: kein Protokoll in der Doku-Tabelle`); continue; }
    const route = routeByApi.get(api);
    if (!route) { stats.unresolved.push(`${id}: Protokoll ${api} hat keine verwaltete Route`); continue; }
    const entry = findRegistryEntry(registryModels, id);
    if (!entry) { stats.unresolved.push(`${id}: keine Registry-Metadaten (Name/Limits unbekannt)`); continue; }
    // Erst hier melden: eine übernommene ID, die an den Metadaten scheitert,
    // ist nicht "gerettet" — sie steht in unresolved.
    if (carried) stats.carried.push(id);

    const fresh = mapLimits(entry);
    const limits = fresh ?? snapshotLimits.get(id) ?? null;
    const model = { id, name: entry.name ?? id };
    if (limits) {
      model.contextWindow = limits.contextWindow;
      model.maxTokens = limits.maxTokens;
      if (!fresh) { model.needsReview = true; stats.reusedLimits.push(id); }
    } else {
      // Kapazität unbekannt: Feld WEGLASSEN statt raten — llm-pi-ai setzt
      // dann seine Routen-Defaults (262144 / 32768).
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
    stats.members += models.length; // LIVE-Mitglieder (vor Reparatur) — Basis der Gurte
    stats.perRoute[name] = models.length; // auch im Verweigerungsfall diagnostizierbar
  }

  // Gurt 1: zu wenige live aufgelöste Modelle -> gar nicht schreiben.
  if (stats.members < minAutoModels) {
    return { ok: false, reason: `nur ${stats.members} Modelle mit bekanntem Protokoll (< minAutoModels=${minAutoModels}) — Snapshot gilt`, stats };
  }
  // Gurt 2: Verhältnis zur zuletzt übernommenen Menge. Schützt gegen eine
  // DEGRADIERTE (nicht tote) Quelle: eine dünne Antwort würde sonst still den
  // halben Picker leeren und die fehlenden IDs als "retired" stempeln.
  const ratioFloor = Math.ceil(minAutoRatio * snapshotIds.size);
  if (minAutoRatio > 0 && snapshotIds.size > 0 && stats.members < ratioFloor) {
    return { ok: false, reason: `nur ${stats.members} von zuletzt ${snapshotIds.size} Modellen (< minAutoRatio=${minAutoRatio}) — Quelle wirkt degradiert, Snapshot gilt`, stats };
  }

  // Gurt 3: eine Route OHNE Modelle darf nie geschrieben werden. llm-pi-ai
  // lehnt "resolves no models" ab, und weil alle drei Routen in EINER
  // mutate-Op-Liste stehen, würde EINE leere Gruppe auch die gesunden
  // Gruppen blockieren. Statt zu verweigern: diese Route aus dem Snapshot
  // bedienen und das melden.
  // WICHTIG: nur IDs übernehmen, die der Live-Bau nicht schon anderswo
  // platziert hat — sonst stünde dasselbe Modell unter zwei Protokollen im
  // Picker, und eines davon scheitert zur Laufzeit (500 / "not supported for
  // format"). Der Zustand wäre selbst-erhaltend, weil --adopt ihn in den
  // Snapshot schreibt.
  for (const [name, rec] of Object.entries(routes)) {
    if (rec.models.length > 0) continue;
    const placed = new Set(Object.values(routes).flatMap((r) => r.models.map((m) => m.id)));
    // Verworfene IDs auch hier aussperren: ein leerer Platz darf keine ID
    // zurückholen, deren Protokoll die Live-Doku gerade widersprochen hat.
    const repair = (routeDefs[name]?.models ?? []).filter((m) => !placed.has(m.id) && !rejects.has(m.id));
    if (repair.length === 0) {
      return { ok: false, reason: `Route ${name} ohne Modelle und ohne freien Snapshot-Rückfall — Snapshot gilt`, stats };
    }
    routes[name] = { ...rec, models: repair };
    stats.snapshotRoutes.push(name);
  }

  for (const [name, rec] of Object.entries(routes)) stats.perRoute[name] = rec.models.length;

  for (const id of snapshotIds) {
    if (!Object.values(routes).some((r) => r.models.some((m) => m.id === id))) stats.removed.push(id);
  }
  for (const rec of Object.values(routes)) {
    for (const m of rec.models) if (!snapshotIds.has(m.id)) stats.added.push(m.id);
  }
  stats.added.sort();
  stats.removed.sort();

  return { ok: true, routes, stats };
}
