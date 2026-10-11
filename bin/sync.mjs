// bin/sync.mjs — Fresh-Refresh für catalog/models.json aus dem Live-Registry.
//
// Quelle: https://models.opencode.ai/api.json (dasselbe Format wie models.dev,
// opencode-go-Sektion = exaktes Abo-Roster mit reasoning_options, modalities,
// limits). Kein Key nötig, kein Secret-Handling.
//
// Politik:
// - Mitgliedschaft bleibt kuratiert: Neue Live-IDs werden GEMELDET, nicht
//   automatisch einsortiert (Protokoll steht in keinem Endpoint — vor dem
//   Einsortieren beide Endpunkte proben, siehe catalog/models.json).
// - Felder (input, limits, reasoningEfforts) werden FRESH überschrieben.
// - Kapazitäten werden NIE geraten: fehlt ein Wert, bleibt der alte stehen und
//   das Modell bekommt needsReview:true.
//
// Gebrauch:
//   node bin/sync.mjs --dry-run   (Standard: nur Report, schreibt nichts)
//   node bin/sync.mjs --write      (Felder fresh schreiben + generated-Datum)
//   node bin/sync.mjs --check      (offline: nur Snapshot-Regeln prüfen)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapReasoningEfforts, mapInput, mapLimits } from '../lib/reasoning.mjs';

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
    for (const m of rec.models ?? []) {
      if (!m.id || !m.name || !m.contextWindow || !m.maxTokens || !m.input) {
        problems.push(`${route}/${m.id ?? '?'}: Pflichtfeld fehlt (id/name/contextWindow/maxTokens/input)`);
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
  if (models[id]) return models[id];
  const hit = Object.keys(models).find((k) => k === `opencode-go/${id}` || k.split('/').pop() === id);
  return hit ? models[hit] : null;
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
  console.log(write ? 'Modus: --write (Felder fresh schreiben)' : 'Modus: --dry-run (schreibt nichts)');

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
  const added = [...regIds].filter((id) => !snapIds.has(id)).sort();

  console.log(`\nFeld-Updates: ${fieldChanges.length}`);
  for (const c of fieldChanges) console.log('  ~ ' + c);
  console.log(`Neu live (nicht im Snapshot — manuell triagieren, NICHT auto-einsortiert): ${added.length ? '' : '(keine)'}`);
  const KNOWN_RESPONSES = ['grok-4.7', 'grok-4.6', 'gpt-6-luna', 'gpt-5.6-luna', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor', 'grok-4.5'];
  const KNOWN_MESSAGES = ['claude-haiku-5-5', 'minimax-m3', 'minimax-m2.7', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus'];
  for (const id of added) {
    const hint = KNOWN_RESPONSES.includes(id) ? 'responses' : KNOWN_MESSAGES.includes(id) ? 'messages' : 'completions? (PROBEN!)';
    console.log(`  + ${id}  [${hint}]`);
  }
  if (needsReview.length) {
    console.log('Prüffälle:');
    for (const n of needsReview) console.log('  ! ' + n);
  }

  if (write) {
    snapshot.generated = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + '\n');
    console.log('\nSnapshot geschrieben: ' + SNAPSHOT);
  } else {
    console.log('\nDry-run: nichts geschrieben. Mit --write übernehmen.');
  }
}

main().catch((e) => { console.error('sync fehlgeschlagen:', e.message); process.exit(1); });
