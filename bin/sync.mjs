// bin/sync.mjs — Snapshot-Pflege und Auto-Vorschau aus der Live-Lage.
//
// QUELLEN (alle keyless):
//   https://models.opencode.ai/api.json   Registry: Name, Limits, Modalitäten,
//                                         reasoning_options (models.dev-Format)
//   https://opencode.ai/zen/go/v1/models  Roster: welche IDs es JETZT gibt
//   https://opencode.ai/docs/go/          Protokoll-Orakel: Endpoint-Tabelle
//                                         (leitet seit 2026-10-19 auf
//                                         /v2/docs/console/go/ um)
//
// PROTOKOLL-OHNE-RATEN: Die früheren Listen KNOWN_RESPONSES/KNOWN_MESSAGES
// sind ersetzt. Das Protokoll kommt aus der Doku-Endpoint-Tabelle
// (lib/protocols.mjs); eine ID ohne Doku-Zeile wird als "PROBEN!" gemeldet und
// NICHT einsortiert. Erhebung 2026-10-13: 33 Doku-Zeilen, 0 Widersprüche zum
// hand-kalibrierten Snapshot. Erhebung 2026-10-19 (v2-Doku, Lane im Pfad):
// 28 Zeilen live; IDs, die die Doku nicht mehr listet, behalten das im
// Snapshot belegte Protokoll (carry-over, gemeldet).
//
// GEBRAUCH:
//   node bin/sync.mjs                 Dry-run: Feld-Diffs + neue IDs + Protokoll
//   node bin/sync.mjs --auto          Vorschau: was der Auto-Modus in DSH schreibt
//   node bin/sync.mjs --write         Felder fresh schreiben + generated-Datum
//   node bin/sync.mjs --adopt         Live-Mitgliedschaft in den Snapshot übernehmen
//   node bin/sync.mjs --check         offline: nur Snapshot-Regeln prüfen

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapReasoningEfforts, mapInput, mapLimits } from '../lib/reasoning.mjs';
import { fetchProtocolTable } from '../lib/protocols.mjs';
import { fetchRoster, buildAutoCatalog, findRegistryEntry } from '../lib/live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SNAPSHOT = path.join(ROOT, 'catalog', 'models.json');
const CACHE_DIR = path.join(ROOT, 'catalog', '.cache');
const TIMEOUT_MS = 30_000;

function checkSnapshot(doc) {
  const problems = [];
  const seen = new Set();
  for (const [route, rec] of Object.entries(doc.routes ?? {})) {
    if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(rec.api)) {
      problems.push(`${route}: unbekannte api ${rec.api}`);
    }
    if (rec.baseURL !== 'https://opencode.ai/zen/go/v1') problems.push(`${route}: baseURL weicht ab`);
    if (!(rec.models ?? []).length) problems.push(`${route}: keine Modelle — llm-pi-ai lehnt "resolves no models" ab`);
    for (const m of rec.models ?? []) {
      if (!m.id || !m.name || !m.input) {
        problems.push(`${route}/${m.id ?? '?'}: Pflichtfeld fehlt (id/name/input)`);
      }
      // Kapazitäten sind optional (der Auto-Modus lässt sie weg, wenn die
      // Registry keine nennt) — steht ein Wert da, muss er positiv sein.
      for (const f of ['contextWindow', 'maxTokens']) {
        if (m[f] !== undefined && (!Number.isInteger(m[f]) || m[f] <= 0)) {
          problems.push(`${route}/${m.id}: ${f} muss positiver Integer sein (${m[f]})`);
        }
      }
      if (seen.has(m.id)) problems.push(`Doppel-ID: ${m.id}`);
      seen.add(m.id);
    }
  }
  return { problems, ids: seen };
}

async function fetchRegistry() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const etagFile = path.join(CACHE_DIR, 'registry.etag');
  const bodyFile = path.join(CACHE_DIR, 'registry.json');
  const etag = fs.existsSync(etagFile) ? fs.readFileSync(etagFile, 'utf8').trim() : null;
  const res = await fetch('https://models.opencode.ai/api.json', {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
  });
  if (res.status === 304 && fs.existsSync(bodyFile)) {
    return { data: JSON.parse(fs.readFileSync(bodyFile, 'utf8')), cached: true };
  }
  if (!res.ok) throw new Error(`Registry -> HTTP ${res.status}`);
  const data = await res.json();
  fs.writeFileSync(bodyFile, JSON.stringify(data));
  const newEtag = res.headers.get('etag');
  if (newEtag) fs.writeFileSync(etagFile, newEtag);
  return { data, cached: false };
}

function findEntry(models, id) {
  // Eine Auflösung für alle: liegt in lib/live.mjs (Host-Modul nutzt dieselbe).
  return findRegistryEntry(models, id);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));

  if (args.has('--check')) {
    const { problems, ids } = checkSnapshot(snapshot);
    console.log(`Snapshot-Check: ${ids.size} Modelle, ${problems.length} Probleme`);
    for (const p of problems) console.log('  ! ' + p);
    process.exit(problems.length ? 1 : 0);
  }

  const write = args.has('--write');
  const adopt = args.has('--adopt');
  const autoPreview = args.has('--auto');
  console.log(adopt ? 'Modus: --adopt (Live-Mitgliedschaft in den Snapshot)'
    : autoPreview ? 'Modus: --auto (Vorschau der Auto-Routen, schreibt nichts)'
      : write ? 'Modus: --write (Felder fresh schreiben)' : 'Modus: --dry-run (schreibt nichts)');

  const { data: registry, cached } = await fetchRegistry().catch((e) => {
    console.log(`Registry: FEHLER (${e.message}) — Abbruch ohne Schreibvorgang`);
    process.exit(1);
  });
  console.log(`Registry: geladen${cached ? ' (304, Cache)' : ''}`);
  const goModels = registry['opencode-go']?.models ?? registry?.providers?.['opencode-go']?.models;
  if (!goModels || typeof goModels !== 'object') {
    console.log('Registry-Parsing: opencode-go-Sektion nicht gefunden (Format geändert?) — Abbruch');
    process.exit(1);
  }
  const regIds = new Set(Object.keys(goModels).map((k) => k.split('/').pop()));
  console.log(`Registry: ${regIds.size} opencode-go-IDs`);

  // Live-Roster + Protokoll-Orakel: die beiden Quellen, die der Auto-Modus
  // auch zur Laufzeit benutzt. Beide keyless, beide mit Last-Good-Cache.
  const roster = await fetchRoster({}, { cacheDir: CACHE_DIR });
  const oracle = await fetchProtocolTable({}, { cacheDir: CACHE_DIR, roster: roster.ids });
  console.log(`Roster: ${roster.ids ? roster.ids.size : 0} IDs (${roster.source})`
    + ` | Protokoll-Orakel: ${oracle.table ? Object.keys(oracle.table).length : 0} IDs (${oracle.source})`
    + (oracle.finalUrl ? ` @ ${oracle.finalUrl}` : ''));
  if (oracle.degraded) console.log('  ! Orakel DEGRADIERT — Doku-Format hat sich geändert, es gilt der Cache. Neue Modelle bleiben draussen.');
  if (oracle.carried?.length) console.log(`  Protokoll aus dem Cache (Doku listet die ID nicht mehr): ${oracle.carried.join(', ')}`);
  if (oracle.conflicts?.length) for (const c of oracle.conflicts) console.log('  ! Orakel-Konflikt: ' + c);

  const auto = buildAutoCatalog({
    snapshot,
    registryModels: goModels,
    roster: roster.ids ?? [],
    protocols: oracle.table ?? {},
    cfg: {},
  });

  if (autoPreview) {
    console.log(`\nAuto-Modus: ${auto.ok ? 'würde schreiben' : 'VERWEIGERT'} — ${auto.ok ? auto.stats.members + ' live aufgelöste Modelle' : auto.reason}`);
    console.log('  Gurte: minAutoModels=8 minAutoRatio=0.6 minProtocolRows=10 (Defaults — der Host kann per config abweichen)');
    for (const [route, n] of Object.entries(auto.stats.perRoute)) console.log(`  ${route}: ${n}`);
    console.log(`  neu im Picker: ${auto.stats.added.length ? auto.stats.added.join(', ') : '(keine)'}`);
    console.log(`  fällt raus:    ${auto.stats.removed.length ? auto.stats.removed.join(', ') : '(keine)'}`);
    if (auto.stats.snapshotRoutes.length) console.log(`  aus dem Snapshot bedient (leere Route): ${auto.stats.snapshotRoutes.join(', ')}`);
    if (auto.stats.unresolved.length) {
      console.log('  unresolved (bleibt draussen, kein Protokoll/Metadaten):');
      for (const u of auto.stats.unresolved) console.log('    - ' + u);
    }
    if (auto.stats.vetoed.length) console.log(`  Veto-Liste: ${auto.stats.vetoed.join(', ')}`);
    if (auto.stats.carried.length) console.log(`  Protokoll aus dem Snapshot übernommen (Doku listet sie nicht mehr): ${auto.stats.carried.join(', ')}`);
    if (auto.stats.reusedLimits.length) console.log(`  Limits aus dem Snapshot übernommen: ${auto.stats.reusedLimits.join(', ')}`);
    if (auto.stats.needsReview.length) console.log(`  needsReview (Limits fehlen/aus Snapshot): ${auto.stats.needsReview.join(', ')}`);
    for (const n of auto.stats.notes) console.log('  ! ' + n);
    console.log('\nVorschau: nichts geschrieben.');
    return;
  }

  // Feld-Diffs für die IDs, die im Snapshot stehen und live noch existieren.
  const fieldChanges = [];
  const needsReview = [];
  for (const [route, rec] of Object.entries(snapshot.routes)) {
    for (const m of rec.models) {
      const entry = findEntry(goModels, m.id);
      if (!entry) { needsReview.push(`${m.id}: nicht mehr im Registry (stale-Kandidat)`); continue; }
      const freshInput = mapInput(entry);
      const freshLimits = mapLimits(entry);
      const freshEfforts = mapReasoningEfforts(entry);
      const before = JSON.stringify({ n: m.name, i: m.input, c: m.contextWindow, o: m.maxTokens, e: m.reasoningEfforts ?? null });
      if (freshLimits) {
        m.contextWindow = freshLimits.contextWindow;
        m.maxTokens = freshLimits.maxTokens;
        delete m.needsReview;
      } else {
        m.needsReview = true;
        needsReview.push(`${m.id}: keine Limits im Registry — alte Werte behalten, prüfen!`);
      }
      m.input = freshInput;
      if (freshEfforts === undefined) delete m.reasoningEfforts;
      else m.reasoningEfforts = freshEfforts;
      if (entry.name && entry.name !== m.name) m.name = entry.name;
      const after = JSON.stringify({ n: m.name, i: m.input, c: m.contextWindow, o: m.maxTokens, e: m.reasoningEfforts ?? null });
      if (before !== after) fieldChanges.push(`${m.id}: ${before} -> ${after}`);
    }
  }

  const snapIds = new Set(Object.values(snapshot.routes).flatMap((r) => r.models.map((m) => m.id)));
  const added = [...(roster.ids ?? [])].filter((id) => !snapIds.has(id) && regIds.has(id)).sort();
  // Roster-only-IDs haben weder Metadaten noch Protokoll: der Auto-Modus kann
  // sie nicht aufnehmen, verschweigen darf man sie aber nicht.
  const rosterOnly = [...(roster.ids ?? [])].filter((id) => !snapIds.has(id) && !regIds.has(id)).sort();

  console.log(`\nFeld-Updates: ${fieldChanges.length}`);
  for (const c of fieldChanges) console.log('  ~ ' + c);
  console.log(`Neu live und registry-bekannt (nicht im Snapshot): ${added.length ? '' : '(keine)'}`);
  for (const id of added) {
    const api = oracle.table?.[id];
    console.log(`  + ${id}  [${api ?? 'PROBEN! (keine Doku-Zeile)'}]`);
  }
  if (rosterOnly.length) {
    console.log(`Nur im Roster, ohne Metadaten (bleibt draussen): ${rosterOnly.join(', ')}`);
  }
  if (needsReview.length) {
    console.log('Prüffälle:');
    for (const n of needsReview) console.log('  ! ' + n);
  }
  const gone = [...snapIds].filter((id) => !(roster.ids ?? new Set()).has(id)).sort();
  if (gone.length) console.log(`Nicht mehr live (Auto-Modus wirft sie raus): ${gone.join(', ')}`);

  if (adopt) {
    if (!auto.ok) {
      console.log(`\n--adopt nicht möglich: ${auto.reason}`);
      process.exit(1);
    }
    const stamp = new Date().toISOString().slice(0, 10);
    snapshot.routes = auto.routes;
    if (auto.stats.removed.length) {
      snapshot.retired = { ...(snapshot.retired ?? {}) };
      for (const id of auto.stats.removed) snapshot.retired[id] = `nicht mehr im Live-Roster (${stamp})`;
    }
    snapshot.generated = stamp;
    fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`\nSnapshot übernommen: ${auto.stats.members} Modelle`
      + (auto.stats.added.length ? `, +${auto.stats.added.join(' +')}` : '')
      + (auto.stats.removed.length ? `, -${auto.stats.removed.join(' -')}` : '')
      + ` -> ${SNAPSHOT}`);
  } else if (write) {
    snapshot.generated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + '\n');
    console.log('\nSnapshot geschrieben: ' + SNAPSHOT);
  } else {
    console.log('\nDry-run: nichts geschrieben. Mit --write (Felder) oder --adopt (Mitgliedschaft) übernehmen.');
  }
}

main().catch((e) => { console.error('sync fehlgeschlagen:', e.message); process.exit(1); });
