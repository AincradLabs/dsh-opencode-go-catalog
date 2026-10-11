// bin/snippet.mjs — prints the complete llm-pi-ai replacement row for
// manual installs (INSTALL.md, path A): replace the row with the same id in
// $DSH_HOME/profiles/<profile>/cordis.patch.yml with this output.
// Patch rule: config replaces the row wholesale (no merge) — so this block
// carries the built-in opencode-go route UNCHANGED plus the siblings.
//
// Gebrauch: node bin/snippet.mjs > weg-a-schnellstart.yml

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'models.json'), 'utf8'));

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const ind = (n) => ' '.repeat(n);
const scalar = (v) => Array.isArray(v) ? `[${v.join(', ')}]` : typeof v === 'string' ? v : String(v);

const out = [];
out.push('# Path A — this ONE row fully replaces your "- id: llm-pi-ai" row');
out.push('# in $DSH_HOME/profiles/<profile>/cordis.patch.yml.');
out.push('# Back up that file first! Then restart DSH.');
out.push('# Quelle: catalog/models.json (Stand ' + (doc.generated ?? '?') + ').');
out.push('- id: llm-pi-ai');
out.push('  name: "@deepseek-ai/dsh-llm-pi-ai"');
out.push('  config:');
out.push('    providers:');
out.push('      opencode-go: # eingebaut — unverändert lassen');
out.push('        apiKeyEnv: OPENCODE_GO_API_KEY');
for (const [route, rec] of Object.entries(doc.routes)) {
  out.push(`      ${route}:`);
  out.push(`        apiKeyEnv: OPENCODE_GO_API_KEY`);
  out.push(`        displayName: ${rec.displayName}`);
  out.push(`        api: ${rec.api}`);
  out.push(`        baseURL: ${rec.baseURL}`);
  out.push(`        models:`);
  for (const m of rec.models) {
    out.push(`          - id: ${m.id}`);
    out.push(`            name: "${esc(m.name)}"`);
    out.push(`            contextWindow: ${m.contextWindow}`);
    out.push(`            maxTokens: ${m.maxTokens}`);
    out.push(`            input: [${m.input.join(', ')}]`);
    if (m.reasoningEfforts) {
      out.push(`            reasoningEfforts:`);
      for (const [k, v] of Object.entries(m.reasoningEfforts)) {
        out.push(`              ${k}: ${scalar(v)}`);
      }
    }
  }
}
console.log(out.join('\n') + '\n');
