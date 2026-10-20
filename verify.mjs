// verify.mjs — statische Abnahme für dsh-opencode-go-catalog (offline, ohne DSH).
// Prüft: package.json-Manifest, Bundle-Patch-Form, Katalog-Regeln.
// Gebrauch: node verify.mjs   (Exit 1 bei Fehlern)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReasoningEfforts } from './lib/reasoning.mjs';
import { parseProtocolTable, fetchProtocolTable } from './lib/protocols.mjs';
import { buildAutoCatalog } from './lib/live.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.');
let failures = 0;
const ok = (msg) => console.log('  ok  ' + msg);
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };
const must = (p) => { if (!fs.existsSync(p)) { fail('fehlt: ' + path.relative(ROOT, p)); return false; } return true; };

console.log('== package.json ==');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
(pkg.name === 'dsh-opencode-go-catalog') ? ok('name passt zum Ordner-Konzept') : fail('name unerwartet: ' + pkg.name);
(pkg.type === 'module') ? ok('type: module') : fail('type muss module sein');
(pkg.main === './lib/index.js' && must(path.join(ROOT, 'lib/index.js'))) ? ok('main zeigt auf existierende Datei') : fail('main/lib fehlt');
(pkg.dsh?.bundle?.patch === './cordis.patch.yml' && must(path.join(ROOT, 'cordis.patch.yml')))
  ? ok('dsh.bundle.patch zeigt auf existierende Datei') : fail('dsh.bundle.patch fehlt/falsch');
for (const f of (pkg.files ?? [])) {
  if (['lib/index.js', 'lib/reasoning.mjs', 'lib/protocols.mjs', 'lib/live.mjs', 'bin/sync.mjs', 'bin/snippet.mjs', 'cordis.patch.yml', 'catalog/models.json', 'weg-a-schnellstart.yml', 'verify.mjs', 'README.md', 'INSTALL.md', 'LICENSE'].includes(f)) {
    must(path.join(ROOT, f)) ? ok('files enthält vorhandenes ' + f) : null;
  }
}
for (const f of ['lib/protocols.mjs', 'lib/live.mjs']) {
  (pkg.files ?? []).includes(f) ? ok('files enthält ' + f + ' (sonst fehlt das Modul in der Installation)') : fail('files muss ' + f + ' enthalten');
}
if (pkg.dependencies && Object.keys(pkg.dependencies).length) fail('soll zero-dep sein, hat dependencies');
else ok('zero-dep (keine dependencies)');
const peers = Object.keys(pkg.peerDependencies ?? {});
if (peers.some((p) => p.startsWith('@deepseek-ai/dsh'))) fail('dsh-Peers riskieren Gate-Refusals — absichtlich keine deklarieren');
else ok('keine @deepseek-ai/dsh*-Peers (Gate kann nicht verweigern)');

console.log('== cordis.patch.yml ==');
const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
const patchLines = patch.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
patchLines[0].trim() === '- insert:' ? ok('Neue Row unter - insert: (nacktes - id: würde als Override verworfen)') : fail('Patch muss mit "- insert:" beginnen');
patch.includes('- id: opencode-go-catalog') ? ok('stabile Row-id vorhanden') : fail('Row-id opencode-go-catalog fehlt');
patch.includes('name: dsh-opencode-go-catalog') ? ok('Row-Name = Paketname') : fail('Row-Name muss Paketname sein');
patch.includes('enabled:') ? ok('enabled-Toggle vorhanden') : fail('enabled fehlt');

console.log('== lib/index.js (Host-Naht, gegen DSH 0.2.0-rc.2 Quellen geprüft) ==');
const hostSrc = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
hostSrc.includes('.register({') && hostSrc.includes("name: 'opencode-go-sync'") ? ok('command-Registrierung in Objektform') : fail('commands.register-Objektform fehlt');
hostSrc.includes('mutate(ADAPTER_NS, ops') ? ok('mutate(ns, ops)-Naht mit Entry-Namespace') : fail('mutate(ns, ops)-Naht fehlt');
hostSrc.includes('settingsNamespace') ? fail('settingsNamespace-Import muss raus (Host-API heißt anders)') : ok('kein settingsNamespace-Import');
hostSrc.includes("reg.register('opencode-go-sync'") ? fail('alte register-Signatur noch vorhanden') : ok('alte register-Signatur weg');
hostSrc.includes('startupDelaySeconds') && hostSrc.includes('setTimeout') ? ok('Startup-Delay implementiert') : fail('Startup-Delay fehlt');
hostSrc.includes('STATUS_FILE') ? ok('status.json-Diagnose vorhanden') : fail('status.json-Diagnose fehlt');
(!hostSrc.includes('return { ok: true }') && !hostSrc.includes('return { ok: false, degraded')) ? ok('apply() löst void auf (Fiber-Effect-Regel, kein Invalid effect)') : fail('apply() darf kein Objekt zurückgeben (Invalid effect)');
hostSrc.includes("ctx.inject(['settings']") ? ok('Service-Zugriff via ctx.inject (Fiber-Scope)') : fail('ctx.inject fehlt — direkter Zugriff ist im Fiber leer');
hostSrc.includes('x-opencode-session') ? ok('statischer Session-Header für Sibling-Routen (gegen MissingSessionID-400)') : fail('x-opencode-session fehlt');
hostSrc.includes("definitionId: 'dsh-opencode-go-catalog/opencode-go-sync'") ? ok('definitionId wie working Producer (plan-mode)') : fail('definitionId fehlt');
hostSrc.includes('cmdProbe') ? ok('Registry-Selbst-Probe (find/list) vorhanden') : fail('cmdProbe fehlt');

console.log('== catalog/models.json ==');
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'models.json'), 'utf8'));
const routes = doc.routes ?? {};
const expected = { 'opencode-go-extras': 'openai-completions', 'opencode-go-responses': 'openai-responses', 'opencode-go-messages': 'anthropic-messages' };
let total = 0;
let needsReviewCount = 0;
const seen = new Set();
for (const [route, api] of Object.entries(expected)) {
  const rec = routes[route];
  if (!rec) { fail('Route fehlt: ' + route); continue; }
  (rec.api === api) ? ok(`${route}: api=${api}`) : fail(`${route}: api ist ${rec.api}, erwartet ${api}`);
  (rec.baseURL === 'https://opencode.ai/zen/go/v1') ? ok(`${route}: baseURL korrekt`) : fail(`${route}: baseURL falsch`);
  for (const m of rec.models ?? []) {
    total++;
    // Pflicht ist id/name/input. Kapazitäten sind OPTIONAL (der Auto-Modus
    // lässt sie weg, wenn die Registry keine nennt -> llm-pi-ai-Defaults);
    // stehen sie da, müssen sie positive Integer sein. Muss zu
    // bin/sync.mjs checkSnapshot() passen — sonst fällt der dokumentierte
    // Ablauf "--adopt -> verify.mjs" über seinen eigenen Zustand.
    if (!m.id || !m.name || !m.input) fail(`${route}: ${m.id ?? '?'} unvollständig (id/name/input)`);
    for (const f of ['contextWindow', 'maxTokens']) {
      if (m[f] !== undefined && (!Number.isInteger(m[f]) || m[f] <= 0)) fail(`${m.id}: ${f} muss positiver Integer sein (${m[f]})`);
    }
    if (m.needsReview) needsReviewCount++;
    if (seen.has(m.id)) fail('Doppel-ID: ' + m.id);
    seen.add(m.id);
    for (const p of validateReasoningEfforts(m.id, m.reasoningEfforts)) fail(p);
    if (!Array.isArray(m.input) || m.input.some((x) => !['text', 'image'].includes(x))) {
      fail(`${m.id}: input darf nur text/image enthalten (pi-ai MODALITIES)`);
    }
  }
}
if (!('opencode-go' in routes)) ok('eingebaute Route nicht im Snapshot (Sicherheitsgurt)');
else fail('Snapshot darf opencode-go NICHT enthalten');
console.log(`   Snapshot gesamt: ${total} Modelle auf ${Object.keys(routes).length} Routen, ${needsReviewCount} mit needsReview`);
if (!seen.has('step-5-preview-free')) fail('step-5-preview-free fehlt — Hauptgrund des Plugins!');
else ok('step-5-preview-free enthalten');

console.log('== lib/protocols.mjs (Protokoll-Orakel, Fixture offline) ==');
const FIXTURE = `<table>
<tr><td>Cat Jam Free</td><td>cat-jam-free</td><td>https://opencode.ai/inference/go/v1/chat/completions</td><td>@ai-sdk/openai-compatible</td></tr>
<tr><td>Grok 4.7</td><td>grok-4.7</td><td>https://opencode.ai/inference/go/v1/responses</td><td>@ai-sdk/openai</td></tr>
<tr><td>Claude Haiku 5.5</td><td>claude-haiku-5-5</td><td>https://opencode.ai/inference/go/v1/messages</td><td>@ai-sdk/anthropic</td></tr>
<tr><td>MiniMax M3.1 Flash Free</td><td>minimax-m3.1-flash-free</td><td>https://opencode.ai/inference/go/openai/v1/chat/completions</td><td>@ai-sdk/openai-compatible</td></tr>
<tr><td>Nicht live</td><td>not-in-roster</td><td>https://opencode.ai/inference/go/v1/chat/completions</td><td>@ai-sdk/openai-compatible</td></tr>
</table>`;
const fixRoster = new Set(['cat-jam-free', 'grok-4.7', 'claude-haiku-5-5', 'minimax-m3.1-flash-free']);
const parsed = parseProtocolTable(FIXTURE, { roster: fixRoster });
(parsed.table['cat-jam-free'] === 'openai-completions') ? ok('chat/completions -> openai-completions') : fail('cat-jam-free falsch gemappt: ' + parsed.table['cat-jam-free']);
(parsed.table['grok-4.7'] === 'openai-responses') ? ok('responses -> openai-responses') : fail('grok-4.7 falsch gemappt');
(parsed.table['claude-haiku-5-5'] === 'anthropic-messages') ? ok('messages -> anthropic-messages') : fail('claude-haiku-5-5 falsch gemappt');
// Regression 2026-10-19: die v2-Doku stellt die Lane in den Pfad
// (/inference/go/openai/v1/...). Der alte Regex verlangte "/go/v1/" wörtlich und
// lieferte 0 Zeilen -> neue Modelle fielen still aus dem Picker.
(parsed.table['minimax-m3.1-flash-free'] === 'openai-completions')
  ? ok('v2-Pfadform (…/go/<lane>/v1/chat/completions) wird erkannt')
  : fail('v2-Pfadform NICHT erkannt (Regression: minimax-m3.1-flash-free & Co. verschwinden): ' + JSON.stringify(parsed.table));
(!('not-in-roster' in parsed.table) && parsed.ignored.some((i) => i.includes('not-in-roster')))
  ? ok('Roster-Filter wirft Fremd-IDs weg (Regex-Fehltreffer erreichen keine Route)')
  : fail('Roster-Filter greift nicht');
const sdkConflict = parseProtocolTable(FIXTURE + '<tr><td>Beam X</td><td>beam-x</td><td>https://opencode.ai/inference/go/openai/v1/chat/completions</td><td>@ai-sdk/anthropic</td></tr>', { roster: new Set([...fixRoster, 'beam-x']) });
(!('beam-x' in sdkConflict.table) && sdkConflict.conflicts.some((c) => c.includes('beam-x')))
  ? ok('URL-Pfad und SDK-Spalte uneinig -> ID fliegt raus (Gegenprobe statt raten)')
  : fail('SDK-Gegenprobe greift nicht: ' + JSON.stringify({ table: sdkConflict.table['beam-x'], conflicts: sdkConflict.conflicts }));
const conflict = parseProtocolTable(FIXTURE + '<tr><td>Cat Jam Free</td><td>cat-jam-free</td><td>https://opencode.ai/inference/go/v1/responses</td><td>@ai-sdk/openai</td></tr>', { roster: fixRoster });
(conflict.conflicts.length === 1 && !('cat-jam-free' in conflict.table))
  ? ok('widersprüchliche Doppelzeile: ID fliegt ganz raus (nicht die erste behalten = raten) und wird gemeldet')
  : fail('Konflikt-Erkennung greift nicht: ' + JSON.stringify({ conflicts: conflict.conflicts, value: conflict.table['cat-jam-free'] }));
// N6: @ai-sdk/openai bedient BEIDE OpenAI-Endpunkte. Eine chat/completions-Zeile
// mit diesem Paket ist kein Widerspruch und darf nicht verworfen werden.
const sdkWide = parseProtocolTable('<tr><td>Chatty</td><td>chatty</td><td>https://opencode.ai/inference/go/openai/v1/chat/completions</td><td>@ai-sdk/openai</td></tr>', { roster: new Set(['chatty']) });
(sdkWide.table.chatty === 'openai-completions')
  ? ok('@ai-sdk/openai auf chat/completions ist kein Widerspruch (Paket bedient beide Endpunkte)')
  : fail('N6-Regression: legitime chat-Zeile mit @ai-sdk/openai wird verworfen: ' + JSON.stringify({ table: sdkWide.table, conflicts: sdkWide.conflicts }));
// B3: ein unbekannter Endpunkt bleibt unbekannt — auch mit bekannter SDK-Spalte.
const noRescue = parseProtocolTable('<tr><td>Emb</td><td>emb-model</td><td>https://opencode.ai/inference/go/openai/v1/embeddings</td><td>@ai-sdk/openai-compatible</td></tr>', { roster: new Set(['emb-model']) });
(!('emb-model' in noRescue.table) && noRescue.ignored.some((i) => i.startsWith('emb-model')))
  ? ok('unbekannter Endpunkt wird NICHT über die SDK-Spalte gerettet (kein Raten)')
  : fail('B3: Endpunkt-Rettung wieder drin: ' + JSON.stringify(noRescue.table));

console.log('== lib/live.mjs (Auto-Mitgliedschaft, Fixture offline) ==');
const snapFixture = {
  routes: {
    'opencode-go-extras': { api: 'openai-completions', baseURL: 'https://x/v1', displayName: 'extras', models: [{ id: 'old-gone', name: 'Old Gone', contextWindow: 1000, maxTokens: 100, input: ['text'] }] },
    'opencode-go-responses': { api: 'openai-responses', baseURL: 'https://x/v1', displayName: 'responses', models: [] },
    // messages hat bewusst einen Snapshot-Eintrag: der Leer-Routen-Gurt soll
    // hier NICHT greifen (er hat einen eigenen Test unten).
    'opencode-go-messages': { api: 'anthropic-messages', baseURL: 'https://x/v1', displayName: 'messages', models: [{ id: 'old-msg', name: 'Old Msg', contextWindow: 1000, maxTokens: 100, input: ['text'] }] },
  },
  excluded: { 'veto-me': 'Testveto', '_hinweis': 'Kommentar, keine ID' },
};
const regFixture = {
  'a-new': { id: 'a-new', name: 'A New', limit: { context: 111, output: 22 }, modalities: { input: ['text', 'image'] }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
  'veto-me': { id: 'veto-me', name: 'Veto', limit: { context: 1, output: 1 }, modalities: { input: ['text'] } },
  'no-proto': { id: 'no-proto', name: 'No Proto', limit: { context: 1, output: 1 }, modalities: { input: ['text'] } },
  'no-meta': { id: 'no-meta', name: 'No Meta' },
};
const autoFixture = buildAutoCatalog({
  snapshot: snapFixture,
  registryModels: regFixture,
  roster: ['a-new', 'veto-me', 'no-proto', 'no-meta'],
  protocols: { 'a-new': 'openai-completions', 'veto-me': 'openai-completions', 'no-meta': 'openai-responses' },
  cfg: { minAutoModels: 1 }, // Fixture hat nur 1 Mitglied — Gurt unten separat geprüft
});
const only = autoFixture.routes['opencode-go-extras'].models;
(autoFixture.ok && autoFixture.stats.members === 2) ? ok('Mitglied = Roster ∩ Registry ∩ Protokoll (2 von 4: a-new + no-meta)') : fail('Mitgliederzahl falsch: ' + autoFixture.stats.members);
(only.length === 1 && only[0].id === 'a-new' && only[0].contextWindow === 111 && only[0].maxTokens === 22) ? ok('Registry-Felder landen im Eintrag') : fail('Eintrag falsch aufgebaut');
(JSON.stringify(only[0].input) === '["text","image"]') ? ok('Modalitäten gemappt') : fail('input falsch: ' + JSON.stringify(only[0].input));
(JSON.stringify(only[0].reasoningEfforts) === '{"low":"low","high":"high"}') ? ok('reasoningEfforts gemappt') : fail('reasoningEfforts falsch');
const noLimits = autoFixture.routes['opencode-go-responses'].models[0];
(noLimits?.id === 'no-meta' && noLimits.contextWindow === undefined && noLimits.needsReview === true)
  ? ok('fehlende Limits werden NICHT erfunden (Feld weg + needsReview -> llm-pi-ai-Defaults)')
  : fail('Limit-Regel verletzt: ' + JSON.stringify(noLimits));
(autoFixture.stats.added.includes('a-new') && autoFixture.stats.removed.includes('old-gone')) ? ok('added/removed korrekt gemeldet') : fail('added/removed falsch');
(autoFixture.stats.vetoed.length === 1 && autoFixture.stats.vetoed[0] === 'veto-me') ? ok('Veto-Liste greift, "_"-Kommentare zählen nicht als ID') : fail('Veto-Liste falsch: ' + JSON.stringify(autoFixture.stats.vetoed));
(autoFixture.stats.unresolved.length === 1 && autoFixture.stats.unresolved[0].startsWith('no-proto'))
  ? ok('unresolved statt raten (kein Protokoll)') : fail('unresolved falsch: ' + JSON.stringify(autoFixture.stats.unresolved));
// Carry-over (19.10.2026): die v2-Doku listet nicht mehr jedes live vorhandene
// Modell. Fehlt die Zeile, gilt das im Snapshot bereits belegte Protokoll —
// gemeldet, damit die Zweithändigkeit sichtbar bleibt.
const carrySnap = {
  routes: {
    'opencode-go-extras': { api: 'openai-completions', baseURL: 'https://x/v1', displayName: 'extras', models: [{ id: 'doc-gone', name: 'Doc Gone', contextWindow: 1000, maxTokens: 100, input: ['text'] }] },
    'opencode-go-messages': { api: 'anthropic-messages', baseURL: 'https://x/v1', displayName: 'messages', models: [{ id: 'doc-live', name: 'Doc Live', contextWindow: 1000, maxTokens: 100, input: ['text'] }] },
  },
};
const carryReg = {
  'doc-gone': { id: 'doc-gone', name: 'Doc Gone', limit: { context: 10, output: 5 }, modalities: { input: ['text'] } },
  'doc-live': { id: 'doc-live', name: 'Doc Live', limit: { context: 10, output: 5 }, modalities: { input: ['text'] } },
};
const carriedAuto = buildAutoCatalog({
  snapshot: carrySnap,
  registryModels: carryReg,
  roster: ['doc-gone', 'doc-live'],
  protocols: { 'doc-live': 'anthropic-messages' },
  cfg: { minAutoModels: 1, minAutoRatio: 0 },
});
(carriedAuto.ok && carriedAuto.stats.carried.length === 1 && carriedAuto.stats.carried[0] === 'doc-gone'
  && carriedAuto.routes['opencode-go-extras'].models.some((m) => m.id === 'doc-gone'))
  ? ok('Doku listet ID nicht mehr -> belegtes Snapshot-Protokoll gilt weiter (gemeldet als carried)')
  : fail('Carry-over greift nicht: ' + JSON.stringify(carriedAuto.stats.carried));
// B1 (fetch-Seite hat den gleichen Fall): eine ID, deren Protokoll die Live-Doku
// widersprüchlich nennt, darf auch der Snapshot nicht per Carry-over zurückholen.
const rejectSnap = {
  routes: {
    'opencode-go-extras': { api: 'openai-completions', baseURL: 'https://x/v1', displayName: 'extras', models: [
      { id: 'doc-gone', name: 'Doc Gone', contextWindow: 1000, maxTokens: 100, input: ['text'] },
      { id: 'keep-ex', name: 'Keep Ex', contextWindow: 1000, maxTokens: 100, input: ['text'] },
    ] },
    'opencode-go-messages': { api: 'anthropic-messages', baseURL: 'https://x/v1', displayName: 'messages', models: [{ id: 'doc-live', name: 'Doc Live', contextWindow: 1000, maxTokens: 100, input: ['text'] }] },
  },
};
const rejectReg = {
  'doc-gone': { id: 'doc-gone', name: 'Doc Gone', limit: { context: 10, output: 5 }, modalities: { input: ['text'] } },
  'keep-ex': { id: 'keep-ex', name: 'Keep Ex', limit: { context: 10, output: 5 }, modalities: { input: ['text'] } },
  'doc-live': { id: 'doc-live', name: 'Doc Live', limit: { context: 10, output: 5 }, modalities: { input: ['text'] } },
};
const rejectAuto = buildAutoCatalog({
  snapshot: rejectSnap,
  registryModels: rejectReg,
  roster: ['doc-gone', 'keep-ex', 'doc-live'],
  protocols: { 'doc-live': 'anthropic-messages' },
  protocolRejects: ['doc-gone'],
  cfg: { minAutoModels: 1, minAutoRatio: 0 },
});
const rejectIds = Object.values(rejectAuto.routes ?? {}).flatMap((r) => r.models.map((m) => m.id));
(rejectAuto.ok && !rejectIds.includes('doc-gone') && rejectAuto.stats.rejected.includes('doc-gone')
  && rejectAuto.stats.unresolved.some((u) => u.startsWith('doc-gone') && /widersprüchlich/.test(u)))
  ? ok('B1: vom Orakel verworfene ID bleibt draussen, auch der Snapshot holt sie nicht zurück')
  : fail('B1 im Auto-Modus: ' + JSON.stringify({ ids: rejectIds, rejected: rejectAuto.stats.rejected, unresolved: rejectAuto.stats.unresolved }));
const refused = buildAutoCatalog({ snapshot: snapFixture, registryModels: regFixture, roster: ['a-new'], protocols: { 'a-new': 'openai-completions' }, cfg: { minAutoModels: 5 } });
(!refused.ok) ? ok('Sicherheitsgurt: zu wenige Modelle -> Auto verweigert, Snapshot gilt') : fail('minAutoModels-Gurt greift nicht');

// Gurt 3 (Review-Befund 1): eine LEERE Route darf nie geschrieben werden.
// llm-pi-ai lehnt "resolves no models" ab, und weil alle Routen in EINER
// mutate-Op-Liste stehen, würde eine leere Gruppe auch die gesunden blockieren.
const snapWithFallback = {
  routes: {
    'opencode-go-extras': { api: 'openai-completions', baseURL: 'https://x/v1', displayName: 'extras', models: [] },
    'opencode-go-responses': { api: 'openai-responses', baseURL: 'https://x/v1', displayName: 'responses', models: [{ id: 'only-resp', name: 'Only Resp', contextWindow: 10, maxTokens: 5, input: ['text'] }] },
    'opencode-go-messages': { api: 'anthropic-messages', baseURL: 'https://x/v1', displayName: 'messages', models: [{ id: 'only-msg', name: 'Only Msg', contextWindow: 10, maxTokens: 5, input: ['text'] }] },
  },
};
const regAll = { m1: { id: 'm1', name: 'M1', limit: { context: 1, output: 1 }, modalities: { input: ['text'] } }, m2: { id: 'm2', name: 'M2', limit: { context: 1, output: 1 }, modalities: { input: ['text'] } } };
const emptyRoutes = buildAutoCatalog({
  snapshot: snapWithFallback,
  registryModels: regAll,
  roster: ['m1', 'm2'],
  protocols: { m1: 'openai-completions', m2: 'openai-completions' }, // responses+messages bleiben leer
  cfg: { minAutoModels: 1, minAutoRatio: 0 },
});
const emptyOk = emptyRoutes.ok
  && emptyRoutes.routes['opencode-go-responses'].models.length > 0
  && emptyRoutes.routes['opencode-go-messages'].models.length > 0
  && emptyRoutes.stats.snapshotRoutes.length === 2;
emptyOk ? ok('leere Route wird aus dem Snapshot bedient (kein "resolves no models", gesunde Gruppen bleiben live)')
  : fail('Leer-Routen-Gurt greift nicht: ' + JSON.stringify(emptyRoutes.stats));

// Gurt 3b (Re-Review-Befund 1): der Snapshot-Rückfall darf keine ID in eine
// ZWEITE Route legen, die live schon anderswo einsortiert ist — sonst stünde
// dasselbe Modell unter zwei Protokollen im Picker, und eines davon scheitert
// zur Laufzeit. Der Zustand wäre selbst-erhaltend (--adopt schreibt ihn fest).
const dupSnapshot = {
  routes: {
    'opencode-go-extras': { api: 'openai-completions', baseURL: 'https://x/v1', displayName: 'extras', models: [{ id: 'snap-ex', name: 'Snap Ex', contextWindow: 10, maxTokens: 5, input: ['text'] }] },
    'opencode-go-responses': { api: 'openai-responses', baseURL: 'https://x/v1', displayName: 'responses', models: [{ id: 'mover', name: 'Mover', contextWindow: 10, maxTokens: 5, input: ['text'] }] },
    'opencode-go-messages': { api: 'anthropic-messages', baseURL: 'https://x/v1', displayName: 'messages', models: [{ id: 'mover', name: 'Mover', contextWindow: 10, maxTokens: 5, input: ['text'] }, { id: 'snap-msg', name: 'Snap Msg', contextWindow: 10, maxTokens: 5, input: ['text'] }] },
  },
};
const dup = buildAutoCatalog({
  snapshot: dupSnapshot,
  registryModels: { mover: { id: 'mover', name: 'Mover', limit: { context: 1, output: 1 }, modalities: { input: ['text'] } } },
  roster: ['mover'],
  protocols: { mover: 'openai-responses' }, // live jetzt responses -> messages bleibt leer
  cfg: { minAutoModels: 1, minAutoRatio: 0 },
});
const dupIds = Object.values(dup.routes ?? {}).flatMap((r) => r.models.map((m) => m.id));
const dupOk = dup.ok
  && dupIds.filter((x) => x === 'mover').length === 1
  && dup.routes['opencode-go-responses'].models.some((m) => m.id === 'mover')
  && dup.routes['opencode-go-messages'].models.map((m) => m.id).join(',') === 'snap-msg';
dupOk ? ok('Snapshot-Rückfall filtert bereits platzierte IDs (kein Modell unter zwei Protokollen)')
  : fail('Doppel-ID im Rückfall: ' + JSON.stringify({ ok: dup.ok, ids: dupIds, messages: dup.routes?.['opencode-go-messages']?.models?.map((m) => m.id) }));

// Gurt 2 (Review-Befund 5): degradierte Quelle -> verweigern statt halben Picker leeren.
const thin = buildAutoCatalog({ snapshot: snapFixture, registryModels: regFixture, roster: ['a-new'], protocols: { 'a-new': 'openai-completions' }, cfg: { minAutoModels: 1, minAutoRatio: 5 } });
(!thin.ok && /minAutoRatio/.test(thin.reason ?? '')) ? ok('Verhältnis-Gurt: dünne Quelle -> Auto verweigert (minAutoRatio)') : fail('minAutoRatio-Gurt greift nicht: ' + JSON.stringify(thin.reason));

console.log('== lib/protocols.mjs fetchProtocolTable (Netz gestubbt, offline) ==');
// Der Host ruft fetchProtocolTable, nicht parseProtocolTable — die Gurte
// (Cache, degraded, Carry-over) liefen bisher ungetestet (Review-Befund B2).
// globalThis.fetch wird für diesen Block ersetzt und danach zurückgesetzt.
{
  const realFetch = globalThis.fetch;
  const oracleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-go-oracle-'));
  const cacheJson = (name) => path.join(oracleDir, name);
  const warmTable = { 'keep-a': 'openai-completions', 'doc-gone': 'openai-completions', 'beam-x': 'openai-completions' };
  fs.writeFileSync(cacheJson('protocols.json'), JSON.stringify({ fetchedAt: 'x', url: 'x', rows: 3, table: warmTable }));
  const roster = new Set(['keep-a', 'keep-b', 'beam-x', 'doc-gone']);
  const rowsHtml = (rows) => `<table>${rows.map(([n, id, url, sdk]) => `<tr><td>${n}</td><td>${id}</td><td>${url}</td><td>@ai-sdk/${sdk}</td></tr>`).join('')}</table>`;
  const base = 'https://opencode.ai/inference/go';
  try {
    // 1) Netz tot, warmer Cache -> cache-fallback + degraded(network)
    globalThis.fetch = async () => { throw new Error('ENOTFOUND docs.opencode.ai'); };
    const down = await fetchProtocolTable({ minProtocolRows: 2 }, { cacheDir: oracleDir, roster });
    (down.source === 'cache-fallback' && down.degraded === true && down.reason === 'network' && Object.keys(down.table ?? {}).length === 3)
      ? ok('Netz tot + Cache -> cache-fallback, degraded (reason network)')
      : fail('cache-fallback-Fall falsch: ' + JSON.stringify({ source: down.source, reason: down.reason, ids: Object.keys(down.table ?? {}).length }));

    // 2) Netz tot, kein Cache -> failed, Tabelle null (Host nimmt den Snapshot)
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-go-nocache-'));
    const cold = await fetchProtocolTable({}, { cacheDir: emptyDir, roster });
    (cold.source === 'failed' && cold.table === null && cold.degraded === true)
      ? ok('Netz tot ohne Cache -> failed, table null (Snapshot gilt)')
      : fail('failed-Fall falsch: ' + JSON.stringify({ source: cold.source, table: cold.table }));
    fs.rmSync(emptyDir, { recursive: true, force: true });

    // 3) Doku umgebaut (lesbar, aber 0 Zeilen) -> cache-shape-changed + reason shape
    globalThis.fetch = async () => ({ ok: true, status: 200, url: 'https://opencode.ai/v3/docs/go/', text: async () => '<html><body><h1>Go</h1><p>keine Tabelle mehr</p></body></html>' });
    const shape = await fetchProtocolTable({ minProtocolRows: 2 }, { cacheDir: oracleDir, roster });
    (shape.source === 'cache-shape-changed' && shape.reason === 'shape' && shape.parsedRows === 0 && Object.keys(shape.table ?? {}).length === 3)
      ? ok('Doku-Format geändert -> cache-shape-changed, degraded (reason shape), parsedRows 0')
      : fail('shape-Fall falsch: ' + JSON.stringify({ source: shape.source, reason: shape.reason, parsedRows: shape.parsedRows }));

    // 4) Live-Tabelle + Carry-over + Review-Befund B1: eine vom Parser
    //    verworfene ID darf NICHT per Cache zurückkommen.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      url: 'https://opencode.ai/v2/docs/console/go/',
      text: async () => rowsHtml([
        ['Keep A', 'keep-a', `${base}/openai/v1/chat/completions`, 'openai-compatible'],
        ['Keep B', 'keep-b', `${base}/anthropic/v1/messages`, 'anthropic'],
        ['Beam X', 'beam-x', `${base}/openai/v1/chat/completions`, 'anthropic'], // Widerspruch
      ]),
    });
    const live = await fetchProtocolTable({ minProtocolRows: 2 }, { cacheDir: oracleDir, roster });
    (live.source === 'live' && live.finalUrl === 'https://opencode.ai/v2/docs/console/go/')
      ? ok('Live-Lesung: source live, finalUrl wird mitgeführt (Redirect-Ziel sichtbar)')
      : fail('Live-Fall falsch: ' + JSON.stringify({ source: live.source, url: live.finalUrl }));
    (live.table['keep-a'] === 'openai-completions' && live.table['keep-b'] === 'anthropic-messages')
      ? ok('Live-Zeilen korrekt gemappt')
      : fail('Live-Zeilen falsch: ' + JSON.stringify(live.table));
    (live.carried?.includes('doc-gone') && live.table['doc-gone'] === 'openai-completions')
      ? ok('Carry-over: live fehlende ID (doc-gone) behält das belegte Cache-Protokoll')
      : fail('Carry-over greift nicht: ' + JSON.stringify({ carried: live.carried, table: live.table }));
    (!('beam-x' in live.table) && (live.rejected ?? []).includes('beam-x'))
      ? ok('B1-Regression: vom Parser verworfene ID kommt NICHT per Carry-over zurück')
      : fail('B1: verworfene ID wieder im Picker: ' + JSON.stringify({ table: live.table['beam-x'], rejected: live.rejected }));
    const written = JSON.parse(fs.readFileSync(cacheJson('protocols.json'), 'utf8'));
    (!('doc-gone' in (written.table ?? {})) && (written.carried ?? []).includes('doc-gone'))
      ? ok('Cache persistiert nur live gelesene Zeilen (Übernommenes bleibt zweithändig)')
      : fail('Cache enthält zweithändige Zeilen: ' + JSON.stringify({ table: written.table, carried: written.carried }));
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(oracleDir, { recursive: true, force: true });
  }
}

console.log('== Snapshot vs. letzte Live-Erhebung (offline, nur Bericht) ==');
// Der Cache hält seit dem B1-Fix nur live gelesene Zeilen — dieser Vergleich ist
// damit unabhängig vom Carry-over (Review-Befund N8).
const cacheFile = (n) => path.join(ROOT, 'catalog', '.cache', n);
if (fs.existsSync(cacheFile('registry.json')) && fs.existsSync(cacheFile('roster.json')) && fs.existsSync(cacheFile('protocols.json'))) {
  const reg = JSON.parse(fs.readFileSync(cacheFile('registry.json'), 'utf8'));
  const goModels = reg['opencode-go']?.models ?? reg?.providers?.['opencode-go']?.models ?? {};
  const live = buildAutoCatalog({
    snapshot: doc,
    registryModels: goModels,
    roster: JSON.parse(fs.readFileSync(cacheFile('roster.json'), 'utf8')).ids ?? [],
    protocols: JSON.parse(fs.readFileSync(cacheFile('protocols.json'), 'utf8')).table ?? {},
    cfg: {},
  });
  live.ok ? ok(`Auto-Modus rechnet mit der letzten Erhebung: ${live.stats.members} Modelle`) : fail('Auto-Modus verweigert gegen die letzte Erhebung: ' + live.reason);
  console.log(`   Snapshot: ${total} | live: ${live.stats.members} | neu: ${live.stats.added.length} | weg: ${live.stats.removed.length} | unresolved: ${live.stats.unresolved.length}`);
  if (live.stats.added.length || live.stats.removed.length) console.log('   Hinweis: Drift ist normal (Live bewegt sich) — "node bin/sync.mjs --adopt" zieht nach.');
} else {
  console.log('   (übersprungen: kein catalog/.cache vorhanden)');
}

console.log(failures ? `\nERGEBNIS: ${failures} Fehler` : '\nERGEBNIS: alles grün');
process.exit(failures ? 1 : 0);
