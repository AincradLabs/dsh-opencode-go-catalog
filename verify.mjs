// verify.mjs — statische Abnahme für dsh-opencode-go-catalog (offline, ohne DSH).
// Prüft: package.json-Manifest, Bundle-Patch-Form, Katalog-Regeln.
// Gebrauch: node verify.mjs   (Exit 1 bei Fehlern)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReasoningEfforts } from './lib/reasoning.mjs';

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
  if (['lib/index.js', 'lib/reasoning.mjs', 'bin/sync.mjs', 'bin/snippet.mjs', 'cordis.patch.yml', 'catalog/models.json', 'weg-a-schnellstart.yml', 'verify.mjs', 'README.md', 'INSTALL.md', 'LICENSE'].includes(f)) {
    must(path.join(ROOT, f)) ? ok('files enthält vorhandenes ' + f) : null;
  }
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
const seen = new Set();
for (const [route, api] of Object.entries(expected)) {
  const rec = routes[route];
  if (!rec) { fail('Route fehlt: ' + route); continue; }
  (rec.api === api) ? ok(`${route}: api=${api}`) : fail(`${route}: api ist ${rec.api}, erwartet ${api}`);
  (rec.baseURL === 'https://opencode.ai/zen/go/v1') ? ok(`${route}: baseURL korrekt`) : fail(`${route}: baseURL falsch`);
  for (const m of rec.models ?? []) {
    total++;
    if (!m.id || !m.name || !m.contextWindow || !m.maxTokens || !m.input) fail(`${route}: ${m.id ?? '?'} unvollständig`);
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
console.log(`   Snapshot gesamt: ${total} Modelle auf ${Object.keys(routes).length} Routen`);
if (!seen.has('step-5-preview-free')) fail('step-5-preview-free fehlt — Hauptgrund des Plugins!');
else ok('step-5-preview-free enthalten');

console.log(failures ? `\nERGEBNIS: ${failures} Fehler` : '\nERGEBNIS: alles grün');
process.exit(failures ? 1 : 0);
