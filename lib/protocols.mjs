// lib/protocols.mjs — Protokoll-Orakel: Welches Wire-Protokoll spricht eine Model-ID?
//
// WARUM ES DAS GIBT
// Kein JSON-Endpoint nennt das Protokoll. Die Doku-Seite
// https://opencode.ai/docs/go/ führt aber eine Endpoint-Tabelle
// (Model | Model ID | Endpoint | AI-SDK-Paket) für jedes gelistete Go-Modell.
// Erhebung 2026-10-13: 33 IDs mit Doku-Zeile, 0 Widersprüche zum
// hand-kalibrierten Snapshot -> das Orakel ist belastbar genug für
// Auto-Mitgliedschaft.
//
// DOKU-UMBAU 2026-10-19 (der Grund, warum neue Go-Modelle NICHT auftauchten):
// /docs/go/ leitet auf /v2/docs/console/go/ um und die Endpoint-Tabelle nennt
// die URLs in neuer Pfadform:
//   alt: …/inference/go/v1/chat/completions
//   neu: …/inference/go/openai/v1/chat/completions   (Lane steht im Pfad:
//        openai -> chat/completions|responses, anthropic -> messages)
// Der alte ROW_RX verlangte "/go/v1/" wörtlich -> 0 Zeilen -> der minRows-Gurt
// griff und es galt still der Last-Good-Cache vom 13.10. Neue Modelle
// (minimax-m3.1-flash-free war das sichtbare Symptom) waren damit
// "kein Protokoll in der Doku-Tabelle" und fielen still aus dem Picker.
// LEHRE: der Basispfad ist NICHT der Diskriminator, sondern der Endpunkt-
// Suffix. Beide Formen sind erlaubt, und die SDK-Spalte wird als Gegenprobe
// gelesen (sie sagt dasselbe Protokoll unabhängig vom Pfad).
//
// GEGENPROBE DERSELBEN ERHEBUNG
// Der MITGELIEFERTE pi-ai-Katalog (dist/providers/data/opencode-go.json)
// widerspricht der Doku bei drei IDs (minimax-m2.7, qwen3.7-plus,
// qwen3.8-max). Er ist als Orakel untauglich und wird hier absichtlich NICHT
// gelesen — das spart ausserdem einen fragilen Modul-Pfad in die app.asar.
//
// POLITIK: nie raten. Eine ID ohne Doku-Zeile bleibt unresolved und wird
// gemeldet (status.json), nicht einsortiert. Fällt die Tabelle weg oder
// schrumpft sie unter minRows, gilt der Snapshot (fail-safe).

import fs from 'node:fs';
import path from 'node:path';

const DOCS_URL = 'https://opencode.ai/docs/go/';

// Endpunkt-Suffix -> pi-ai-api. Der Basispfad ist absichtlich egal
// (die Doku nennt /inference/go/…, pi-ai fährt /zen/go/v1/…).
export const ENDPOINT_TO_API = {
  '/chat/completions': 'openai-completions',
  '/responses': 'openai-responses',
  '/messages': 'anthropic-messages',
};

// AI-SDK-Paket der vierten Tabellenspalte -> Protokolle, die dieses Paket
// bedienen kann. Zweite, pfadunabhängige Aussage derselben Zeile: sie wird als
// GEGENPROBE benutzt (Widerspruch zur URL -> ID fliegt raus und wird gemeldet).
// Sie ist bewusst KEIN Ersatz für einen unbekannten Endpunkt: ein neuer
// Endpunkt-Typ (z. B. /embeddings) wäre sonst als Chat-Protokoll einsortiert —
// genau die Art Raten, die zur Laufzeit mit 500/401 bezahlt wird.
// ACHTUNG (Review-Befund N6): @ai-sdk/openai bedient BEIDE OpenAI-Endpunkte
// (chat/completions und /responses). Nur @ai-sdk/openai-compatible ist auf
// chat/completions festgelegt — deshalb sind es Mengen, keine Einzelwerte.
export const SDK_TO_API = {
  'openai-compatible': ['openai-completions'],
  openai: ['openai-completions', 'openai-responses'],
  anthropic: ['anthropic-messages'],
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
// Der Endpoint-Token deckt BEIDE Doku-Formen ab — /go/v1/<ep> (alt) und
// /go/<lane>/v1/<ep> (v2, kanonisch seit 19.10.2026) — und verlangt weiterhin
// eine Go-Inferenz-URL. Das ist ein PFAD-Anker, kein Host-Anker (Review-Befund
// N1: https://fremdhost/go/v1/chat/completions würde ebenfalls matchen); die
// Grenze gegen Fehltreffer ist der Live-Roster-Filter in parseProtocolTable,
// nicht diese Regex. Die Lane-Klasse erlaubt Bindestriche (N2), damit auch
// "openai-compatible" oder "google" als Lane nicht still verschluckt werden.
const GO_ENDPOINT_RX = String.raw`https:\/\/[^\s"']*\/go\/(?:[a-z0-9-]+\/)?v1\/[a-z\/]+`;
const ROW_RX = new RegExp(
  String.raw`([A-Za-z0-9][A-Za-z0-9 .\-_]*?)\s+([a-z0-9][a-z0-9.\-_]*)\s+(${GO_ENDPOINT_RX})(?:\s+@ai-sdk\/([a-z\-]+))?`,
  'g',
);

// Reiner Parser. `roster` ist der harte Filter: nur IDs, die auch live im
// Roster stehen, werden übernommen — damit kann ein Fehltreffer des Regex
// keine erfundene Model-ID in eine Route schreiben.
// Gibt { table, rows, ignored, conflicts, rejected } zurück. `rejected` sind die
// IDs, die wegen eines Widerspruchs BEWUSST aus dem Orakel geflogen sind — sie
// dürfen auch nicht per Carry-over zurückkommen (Review-Befund B1).
export function parseProtocolTable(html, { roster = null } = {}) {
  const text = htmlToText(html);
  const table = {};
  const ignored = [];
  const conflicts = [];
  const rejected = [];
  const conflicted = new Set();
  let rows = 0;

  for (const m of text.matchAll(ROW_RX)) {
    const id = m[2];
    const apiFromUrl = apiForEndpoint(m[3]);
    const apiFromSdk = m[4] ? SDK_TO_API[m[4]] ?? null : null;
    if (!apiFromUrl) { ignored.push(`${id}: Endpoint ${m[3]} unbekannt`); continue; }
    const api = apiFromUrl;
    if (!/^[a-z0-9][a-z0-9.\-]*$/.test(id) || /^v\d+$/.test(id)) { ignored.push(`${id}: keine plausibele Model-ID`); continue; }
    if (roster && !roster.has(id)) { ignored.push(`${id}: nicht im Live-Roster`); continue; }
    rows++;
    if (conflicted.has(id)) continue; // einmal widersprüchlich -> endgültig draussen
    // Gegenprobe der Zeile selbst: URL-Pfad und SDK-Paket beschreiben dasselbe
    // Protokoll. Uneinig -> nicht raten, ID ganz aus dem Orakel nehmen.
    if (apiFromSdk && !apiFromSdk.includes(apiFromUrl)) {
      conflicts.push(`${id}: URL ${apiFromUrl} vs SDK ${m[4]}`);
      delete table[id];
      conflicted.add(id);
      if (!rejected.includes(id)) rejected.push(id);
      continue;
    }
    if (table[id] && table[id] !== api) {
      // Widersprüchliche Doppelzeile: NICHT die erste behalten (das wäre
      // Raten — genau der Fehler, der zur Laufzeit mit 500 bzw. "not
      // supported for format" bezahlt wird), sondern die ID ganz aus dem
      // Orakel nehmen. Sie wird dadurch unresolved und in status.json gemeldet.
      conflicts.push(`${id}: ${table[id]} vs ${api}`);
      delete table[id];
      conflicted.add(id);
      if (!rejected.includes(id)) rejected.push(id);
      continue;
    }
    table[id] = api;
  }
  return { table, rows, ignored, conflicts, rejected };
}

// Holt die Tabelle mit ETag-Cache und Last-Good-Fallback. Wirft nie —
// Netzfehler bedeuten nur: der Snapshot gilt.
//
// CARRY-OVER (19.10.2026): Die v2-Doku listet nicht mehr jedes Roster-Modell
// (z. B. minimax-m2.7 fehlt, ist aber live). Eine live gelesene Tabelle wird
// deshalb mit dem zuletzt BELEGTEN Protokoll aus dem Last-Good-Cache ergänzt —
// nur für IDs, die im Live-Roster stehen und live keine Zeile haben. Das ist
// kein Raten (die Zeile stand schon einmal in der Doku), aber es ist
// zweithändig: der Host meldet die IDs als `carried` in status.json.
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
  // Belegtes Protokoll aus dem Cache für IDs, die live keine Zeile mehr haben.
  // `skip` sind IDs, die der Live-Parser BEWUSST verworfen hat (Widerspruch):
  // die dürfen nicht durch die Hintertür zurückkommen (Review-Befund B1).
  const carryOver = (liveTable, cachedTable, skip = []) => {
    const table = { ...liveTable };
    const carried = [];
    const blocked = new Set(skip);
    if (!cachedTable || typeof cachedTable !== 'object') return { table, carried };
    for (const [id, api] of Object.entries(cachedTable)) {
      if (table[id] || !api) continue;
      if (blocked.has(id)) continue;
      if (roster && !roster.has(id)) continue; // nur was JETZT live ist
      table[id] = api;
      carried.push(id);
    }
    return { table, carried };
  };

  try {
    const res = await fetch(DOCS_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const finalUrl = res.url || DOCS_URL;
    const parsed = parseProtocolTable(await res.text(), { roster });
    const hit = accept(parsed.table, 'live');
    if (!hit) {
      // Form geändert: erst der Last-Good-Cache, dann der Snapshot.
      // `degraded` markiert genau diesen Fall — der Host hebt ihn als WARNUNG
      // hervor, weil hier still neue Modelle aus dem Picker fallen (Lehre aus
      // dem v2-Doku-Umbau vom 19.10.2026: der Gurt hat den Picker gerettet,
      // aber niemand hat die Zeile gelesen). `reason` unterscheidet die
      // Ursachen, damit der Host nicht bei jedem Netz-Hüpfer "Doku-Format
      // geändert" schreit (Review-Befund N3).
      const fallback = accept(readCache()?.table, 'cache-shape-changed');
      log(`Doku-Tabelle: nur ${Object.keys(parsed.table).length} Zeilen (< ${minRows}) von ${finalUrl} — `
        + (fallback ? `Last-Good-Cache gilt (${Object.keys(fallback.table).length} IDs)` : 'kein Cache, Snapshot gilt'));
      // KEIN `rejected` in diesem Zweig: die Seite wird als Ganzes verworfen, ein
      // einzelner Widerspruch aus einem unbrauchbaren Fragment darf keine
      // Cache-Zeile vetoieren. Sonst meldet status.json eine verworfene ID,
      // während genau diese ID aus dem Cache im Picker steht (Review-Nit R1).
      return fallback
        ? { ...fallback, degraded: true, reason: 'shape', finalUrl, parsedRows: Object.keys(parsed.table).length }
        : { table: null, source: 'failed', error: 'Doku-Tabelle unlesbar', degraded: true, reason: 'shape', finalUrl, parsedRows: Object.keys(parsed.table).length };
    }
    if (parsed.conflicts.length) log(`Doku-Tabelle: ${parsed.conflicts.length} widersprüchliche Zeile(n): ${parsed.conflicts.join('; ')}`);
    const { table, carried } = carryOver(hit.table, readCache()?.table, parsed.rejected);
    if (carried.length) log(`Doku-Tabelle: ${carried.length} ID(s) ohne Live-Zeile, belegtes Protokoll aus dem Cache übernommen: ${carried.join(', ')}`);
    try {
      if (bodyFile) {
        // NUR die live gelesenen Zeilen persistieren, nicht die übernommenen:
        // der Cache soll "was die Doku zuletzt gesagt hat" bleiben, sonst wird
        // zweithändiges Wissen still zur Doku-Wahrheit (Review-Befund B1).
        fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
        fs.writeFileSync(bodyFile, JSON.stringify({ fetchedAt: new Date().toISOString(), url: finalUrl, rows: parsed.rows, table: parsed.table, carried }, null, 2) + '\n');
      }
    } catch { /* still */ }
    return {
      ...hit,
      table,
      carried,
      rows: parsed.rows,
      ignored: parsed.ignored,
      conflicts: parsed.conflicts,
      rejected: parsed.rejected,
      finalUrl,
    };
  } catch (err) {
    const cached = readCache();
    const hit = accept(cached?.table, 'cache-fallback');
    if (hit) {
      log(`Doku-Tabelle: ${err?.message ?? err} — Last-Good-Cache gilt (${Object.keys(hit.table).length} IDs)`);
      return { ...hit, degraded: true, reason: 'network', error: String(err?.message ?? err) };
    }
    log(`Doku-Tabelle: ${err?.message ?? err} — Snapshot gilt`);
    return { table: null, source: 'failed', error: String(err?.message ?? err), degraded: true, reason: 'network' };
  }
}
