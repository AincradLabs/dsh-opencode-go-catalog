// lib/protocols.mjs — Protokoll-Orakel: Welches Wire-Protokoll spricht eine Model-ID?
//
// WARUM ES DAS GIBT
// Kein JSON-Endpoint nennt das Protokoll. Die Doku-Seite
// https://opencode.ai/docs/go/ fuehrt aber eine Endpoint-Tabelle
// (Model | Model ID | Endpoint | AI-SDK-Paket) fuer jedes gelistete Go-Modell.
// Erhebung 2026-10-13: 33 IDs mit Doku-Zeile, 0 Widersprueche zum
// hand-kalibrierten Snapshot -> das Orakel ist belastbar genug fuer
// Auto-Mitgliedschaft.
//
// GEGENPROBE DERSELBEN ERHEBUNG
// Der MITGELIEFERTE pi-ai-Katalog (dist/providers/data/opencode-go.json)
// widerspricht der Doku bei drei IDs (minimax-m2.7, qwen3.7-plus,
// qwen3.8-max). Er ist als Orakel untauglich und wird hier absichtlich NICHT
// gelesen — das spart ausserdem einen fragilen Modul-Pfad in die app.asar.
//
// POLITIK: nie raten. Eine ID ohne Doku-Zeile bleibt unresolved und wird
// gemeldet (status.json), nicht einsortiert. Faellt die Tabelle weg oder
// schrumpft sie unter minRows, gilt der Snapshot (fail-safe).

import fs from 'node:fs';
import path from 'node:path';

const DOCS_URL = 'https://opencode.ai/docs/go/';

// Endpunkt-Suffix -> pi-ai-api. Der Basispfad ist absichtlich egal
// (die Doku nennt /inference/go/v1/..., pi-ai faehrt /zen/go/v1/...).
export const ENDPOINT_TO_API = {
  '/chat/completions': 'openai-completions',
  '/responses': 'openai-responses',
  '/messages': 'anthropic-messages',
};

export function apiForEndpoint(url) {
  if (typeof url !== 'string') return null;
  for (const [suffix, api] of Object.entries(ENDPOINT_TO_API)) {
    if (url.endsWith(suffix)) return api;
  }
  return null;
}

// HTML -> Klartext: Skripte/Stile raus, Tags zu Leerzeichen, Entities
// minimal, Whitespace kollabiert. Die Tabelle ist danach eine flache
// Zeichenkette, in der eine Zeile so aussieht:
//   Cat Jam Free cat-jam-free https://…/go/v1/chat/completions @ai-sdk/openai-compatible
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

// Eine Tabellenzeile: Anzeigename, Model-ID, Endpoint, optional SDK-Paket.
const ROW_RX = /([A-Za-z0-9][A-Za-z0-9 .\-_]*?)\s+([a-z0-9][a-z0-9.\-_]*)\s+(https:\/\/[^\s"']*\/go\/v1\/[a-z/]+)(?:\s+@ai-sdk\/[a-z\-]+)?/g;

// Reiner Parser. `roster` ist der harte Filter: nur IDs, die auch live im
// Roster stehen, werden uebernommen — damit kann ein Fehltreffer des Regex
// keine erfundene Model-ID in eine Route schreiben.
// Gibt { table, rows, ignored, conflicts } zurueck.
export function parseProtocolTable(html, { roster = null } = {}) {
  const text = htmlToText(html);
  const table = {};
  const ignored = [];
  const conflicts = [];
  let rows = 0;

  for (const m of text.matchAll(ROW_RX)) {
    const id = m[2];
    const api = apiForEndpoint(m[3]);
    if (!api) { ignored.push(`${id}: Endpoint ${m[3]} unbekannt`); continue; }
    if (!/^[a-z0-9][a-z0-9.\-]*$/.test(id) || /^v\d+$/.test(id)) { ignored.push(`${id}: keine plausibele Model-ID`); continue; }
    if (roster && !roster.has(id)) { ignored.push(`${id}: nicht im Live-Roster`); continue; }
    rows++;
    if (table[id] && table[id] !== api) { conflicts.push(`${id}: ${table[id]} vs ${api}`); continue; }
    table[id] = api;
  }
  return { table, rows, ignored, conflicts };
}

// Holt die Tabelle mit ETag-Cache und Last-Good-Fallback. Wirft nie —
// Netzfehler bedeuten nur: der Snapshot gilt.
export async function fetchProtocolTable(cfg = {}, { cacheDir, roster = null, log = () => {} } = {}) {
  const minRows = Math.max(1, cfg.minProtocolRows ?? 10);
  const timeoutMs = Math.max(1000, cfg.refreshTimeoutMs ?? 30000);
  const bodyFile = cacheDir ? path.join(cacheDir, 'protocols.json') : null;
  const readCache = () => {
    try {
      if (bodyFile && fs.existsSync(bodyFile)) return JSON.parse(fs.readFileSync(bodyFile, 'utf8'));
    } catch { /* still */ }
    return null;
  };
  const accept = (parsed, source) => {
    if (!parsed || Object.keys(parsed).length < minRows) return null;
    return { table: parsed, source };
  };

  try {
    const res = await fetch(DOCS_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseProtocolTable(await res.text(), { roster });
    const hit = accept(parsed.table, 'live');
    if (!hit) {
      log(`Doku-Tabelle: nur ${Object.keys(parsed.table).length} Zeilen (< ${minRows}) — Snapshot gilt`);
      const cached = readCache();
      return accept(cached?.table, 'cache-shape-changed') ?? { table: null, source: 'failed' };
    }
    if (parsed.conflicts.length) log(`Doku-Tabelle: ${parsed.conflicts.length} widerspruechliche Zeile(n): ${parsed.conflicts.join('; ')}`);
    try {
      if (bodyFile) {
        fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
        fs.writeFileSync(bodyFile, JSON.stringify({ fetchedAt: new Date().toISOString(), url: DOCS_URL, rows: parsed.rows, table: parsed.table }, null, 2) + '\n');
      }
    } catch { /* still */ }
    return { ...hit, rows: parsed.rows, ignored: parsed.ignored, conflicts: parsed.conflicts };
  } catch (err) {
    const cached = readCache();
    const hit = accept(cached?.table, 'cache-fallback');
    if (hit) { log(`Doku-Tabelle: ${err?.message ?? err} — Last-Good-Cache gilt (${Object.keys(hit.table).length} IDs)`); return hit; }
    log(`Doku-Tabelle: ${err?.message ?? err} — Snapshot gilt`);
    return { table: null, source: 'failed', error: String(err?.message ?? err) };
  }
}
