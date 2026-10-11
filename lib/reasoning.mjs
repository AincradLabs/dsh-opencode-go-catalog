// lib/reasoning.mjs — reine Mapping-Funktionen Registry -> pi-ai-Format.
// Geteilt von bin/sync.mjs (Snapshot-Refresh) und lib/index.js (Runtime-Refresh).
// Keine I/O, keine Dependencies — direkt testbar.
//
// Registry-Form (live verifiziert 2026-10-10, https://models.opencode.ai/api.json):
//   reasoning_options: [{type:"effort",values:[...]}, {type:"toggle"}, {type:"budget_tokens",...}]
// pi-ai-Form (THINKING_LEVELS aus dem llm-pi-ai-Schema):
//   reasoningEfforts: { off:"none"|null, minimal, low, medium, high, xhigh, max }
//   input: ["text"] bzw. ["text","image"] (pi-ai kennt NUR diese zwei)

// Erlaubte pi-ai-Level. Registry-Vokabular ist identisch, plus "none"
// (bedeutet: explizit abschaltbar -> off:"none").
export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// reasoning_options -> reasoningEfforts-Objekt oder undefined.
// Regeln (gegen Live-Daten kalibriert):
// - "none"-Wert -> off:"none" (explizit kein Reasoning senden).
// - toggle-only / budget_tokens-only / leeres Array / reasoning=false ->
//   undefined (kein Effort-Menü erfinden — sonst lügt der Picker).
// - toggle+effort kombiniert -> effort gewinnt, toggle wird ignoriert.
// - Unbekannte Level-Namen -> werden übersprungen statt geraten.
export function mapReasoningEfforts(entry) {
  if (!entry || entry.reasoning !== true) return undefined;
  const opts = Array.isArray(entry.reasoning_options) ? entry.reasoning_options : [];
  const effort = opts.find((o) => o?.type === 'effort' && Array.isArray(o.values));
  if (!effort) return undefined;
  const out = {};
  for (const v of effort.values) {
    if (v === 'none') { out.off = 'none'; continue; }
    if (LEVELS.includes(v) && v !== 'off') out[v] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// modalities.input -> ["text"] oder ["text","image"].
// pi-ai validiert MODALITIES=[text,image]; video/audio/pdf fallen weg und
// werden hier dokumentiert gedroppt (Bild-Upload geht, Video nicht deklariert).
export function mapInput(entry) {
  const ins = entry?.modalities?.input ?? ['text'];
  const out = ['text'];
  if (ins.includes('image')) out.push('image');
  return out;
}

export function mapLimits(entry) {
  const ctx = entry?.limit?.context ?? null;
  const out = entry?.limit?.output ?? null;
  if (typeof ctx !== 'number' || typeof out !== 'number') return null;
  return { contextWindow: ctx, maxTokens: out };
}

// Validiert ein reasoningEfforts-Objekt gegen die pi-ai-Regeln.
// Gibt Problem-Strings zurück (leer = gültig).
export function validateReasoningEfforts(id, re) {
  const problems = [];
  if (re === undefined) return problems;
  if (typeof re !== 'object' || re === null || Array.isArray(re)) {
    return [`${id}: reasoningEfforts muss Objekt oder weggelassen sein`];
  }
  for (const [k, v] of Object.entries(re)) {
    if (!LEVELS.includes(k)) { problems.push(`${id}: unbekanntes Level "${k}"`); continue; }
    if (k === 'off') {
      if (v !== 'none' && v !== null) problems.push(`${id}: off muss "none" oder null sein`);
    } else if (v !== k) {
      problems.push(`${id}: Level "${k}" muss Identitätswert "${k}" tragen`);
    }
  }
  return problems;
}
