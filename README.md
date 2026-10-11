# dsh-opencode-go-catalog

A self-maintained OpenCode Go model catalog for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH). Versioned snapshot, refresh on command, on/off switch — full control, no upstream waiting.

**Status:** 0.1.0 · 19 models · snapshot 2026-10-11, incl. **Step 5 Preview Free** (`step-5-preview-free`)

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands & scripts](#commands--scripts)
- [Fresh reasoning efforts](#fresh-reasoning-efforts)
- [Maintaining the catalog](#maintaining-the-catalog)
- [Enable / disable](#enable--disable)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Compatibility](#compatibility)
- [License & sources](#license--sources)

## Why

The built-in `opencode-go` catalog in `@deepseek-ai/dsh-llm-pi-ai` is a static build snapshot
(~16 models at the time of writing) that never refreshes itself — new models like Step 5 are
missing until upstream bumps the dependency. See
[Discussion #3957](https://github.com/deepseek-ai/deepseek-harness/discussions/3957).

This plugin never touches the built-in route. It manages three sibling routes through the
official `settings.mutate` seam:

| Route | Protocol | Examples |
|---|---|---|
| `opencode-go-extras` | `openai-completions` | Step 5 Preview Free, GLM-5.3, LongCat-2.0, MiMo-V2.6 |
| `opencode-go-responses` | `openai-responses` | GPT-5.6/6 Luna, Grok 4.6/4.7, Muse Spark 1.2/1.3 |
| `opencode-go-messages` | `anthropic-messages` | Claude Haiku 5.5, Qwen3.8 Max/Flash |

The split is mandatory, not stylistic: some Go models are *Responses-only* (a chat-completions
request answers with a bare `500` or `401 "not supported for format oa-compat"`), others are
*Messages-only*. One route = one protocol.

## How it works

1. `catalog/models.json` is the curated snapshot (protocol-separated, capacities verified).
2. On startup, on an interval (default 4 h), and on `/opencode-go-sync`, the host module
   refreshes `input` / `limits` / `reasoningEfforts` from the live registry
   (`https://models.opencode.ai/api.json`, ETag cache + last-good fallback) and writes the
   three sibling routes via `settings.mutate` (change-only).
3. Membership stays curated: newly appeared live IDs are *reported*, never auto-sorted into a
   route — no endpoint discloses the wire protocol, and a wrong guess fails at request time.
4. The module never throws during boot (degrades to a warning + a ready-to-paste YAML block),
   never edits `node_modules`, and never reads or writes credentials (it only references the
   `OPENCODE_GO_API_KEY` name, same as the built-in route).

## Installation

Prerequisites: DSH running, an OpenCode Go subscription with a working key
(`OPENCODE_GO_API_KEY` already configured — if the built-in `opencode-go` route works, you are set).

**Via Plugin Market** (once listed): Settings → Plugin Market → search
`dsh-opencode-go-catalog` → one-click install → restart → open the model picker.
Expect three new groups (*OpenCode Go extras / responses / messages*) next to the built-in one.

**Manual** (until listed): copy this folder to
`<profile>/node_modules/dsh-opencode-go-catalog`, add `"dsh-opencode-go-catalog"` to
`dsh.profile.bundles` in the profile `package.json` (keep a backup first), restart DSH.

**Without the plugin** (static, no auto-refresh): generate the snippet and replace your
`llm-pi-ai` row with it — see [INSTALL.md](INSTALL.md) and [weg-a-schnellstart.yml](weg-a-schnellstart.yml):

```sh
node bin/snippet.mjs > snippet.yml
```

## Configuration

Bundle row ([cordis.patch.yml](cordis.patch.yml), replaces the whole row — no deep merge):

```yaml
- id: opencode-go-catalog
  name: dsh-opencode-go-catalog
  config:
    enabled: true            # false → sibling routes are removed again
    refreshReasoning: true   # false → use snapshot file values only, no network
    intervalMinutes: 240     # 0 → startup only
    startupDelaySeconds: 10
    refreshTimeoutMs: 120000
    catalogPath: ./catalog/models.json
    managedRoutes:
      - opencode-go-extras
      - opencode-go-responses
      - opencode-go-messages
```

## Commands & scripts

| Command | Effect |
|---|---|
| `/opencode-go-sync` (chat, if a command registry exists) | Immediate rewrite from snapshot + live registry |
| `node bin/sync.mjs --dry-run` (default) | Report: field diffs, new live IDs, stale candidates — writes nothing |
| `node bin/sync.mjs --write` | Rewrite snapshot fields from the registry + stamp the date |
| `node bin/sync.mjs --check` | Offline snapshot rule check |
| `node bin/snippet.mjs` | Print the complete `llm-pi-ai` replacement row for manual installs |
| `node verify.mjs` | Manifest + patch shape + catalog rules (offline) |

## Fresh reasoning efforts

`reasoning_options` in the live registry are structured (`effort` values, `toggle`,
`budget_tokens`) — Models.dev serves the same data. Mapping rules ([lib/reasoning.mjs](lib/reasoning.mjs)):

| Registry | pi-ai `reasoningEfforts` |
|---|---|
| `effort` values (`low`, `medium`, …) | Identity mapping (`low: low`, …) |
| `none` value | `off: none` |
| `toggle`-only / `budget_tokens`-only / empty array | **no** block (never invent a menu — the picker would lie) |
| `toggle` + `effort` combined | `effort` wins |
| `modalities.input` containing `image` | `input: [text, image]` (pi-ai only knows `text`/`image`; `video`/`audio`/`pdf` are dropped documented) |

Live examples: Step 5 Preview Free → `{low, medium, high}`; GPT-5.6 Luna →
`{off: none, low…max}`; Muse Spark → `{minimal…xhigh}` (no `max`!); LongCat-2.0 /
MiniMax M3 (`toggle`-only) → no menu.

## Maintaining the catalog

1. Run `node bin/sync.mjs --dry-run`.
2. Take `~` field updates straight away with `--write` — they come 1:1 from the registry.
3. Triage `+` IDs by hand (this includes built-in catalog models our snapshot deliberately
   doesn't duplicate — genuinely new are IDs in neither place). Probe both endpoints before
   sorting a newcomer into a route, then adopt with `--write`.
4. `node verify.mjs` → `/opencode-go-sync`.

Deliberately excluded (unverified Oct 2026, see `deliberatelyExcluded` in the snapshot):
`glm-5`, `kimi-k2.5`, `mimo-v2-omni/pro`, `qwen3.5-plus`, `hy3-preview`,
`space-bunny-free`, `minimax-m2.5`.

## Enable / disable

- **Siblings off, plugin stays loaded:** set `enabled: false` (settings namespace
  `opencode-go-catalog` or bundle config). The three routes are removed; the built-in
  `opencode-go` route keeps running untouched.
- **Whole plugin off:** add `disabled: true` to the `opencode-go-catalog` bundle row,
  restart. Nothing needs deleting.

## Enable / disable

- **Siblings off, plugin stays loaded:** add your own `- id: opencode-go-catalog` row
  (with the FULL config — patches replace, never merge; copy
  [cordis.patch.yml](cordis.patch.yml) as the template) to your profile patch with
  `enabled: false`. The three routes are removed again via unset ops; the built-in
  `opencode-go` route keeps running untouched.
- **Whole plugin off:** `disabled: true` on the bundle row (or the market's disable
  list), restart. Nothing needs deleting.

## Diagnostics

After every sync attempt the plugin writes `status.json` next to `package.json`
(time, ok, via, changed, command registration, fetch source, error). Open it in any
editor — no log access needed. If the picker stays empty, send this file's content
with your report.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Model answers `500` / `401 not supported for format` | Wrong protocol (e.g. Responses-only model on a completions route) | Move it to the correct sibling route |
| `model '…' needs an api` | Hand-declared route without `api` | Set `api` + `baseURL` + non-empty `models` (the plugin does this automatically) |
| Images rejected before sending | `input` is `[text]` | Set `input: [text, image]` per model (only with proven vision support) |
| No effort menu | `reasoningEfforts` missing | Adopt from the registry's `reasoning_options`; mind `off: none` vs empty `off` |
| Installed but seemingly idle | — | This plugin uses no shell hooks; check the boot log for `[opencode-go-catalog]` |
| Install gate refuses | Peer range with stable lower bound | Not applicable here (no `@deepseek-ai/dsh*` peers declared on purpose) |

Never hand-edit `node_modules/…/pi-ai/dist/providers/data/opencode-go.json` — the next DSH
update discards it silently. This snapshot is the place.

## Security

- **No secrets:** the plugin never reads, writes, logs, or ships credentials. `OPENCODE_GO_API_KEY`
  appears only as a *name reference*, exactly like the built-in route. Verified by pre-commit sweep.
- **Network:** only two public, keyless JSON endpoints
  (`models.opencode.ai/api.json`, `opencode.ai/zen/go/v1/models`), with timeout + ETag cache +
  offline fallback to snapshot values.
- **Zero dependencies**, no `@deepseek-ai/dsh*` peers (the install gate cannot refuse it),
  no shell hooks, fail-safe boot.

## Compatibility

Built against DSH `0.2.0-rc.2` behavior (static pi-ai catalog, `settings.mutate` seam,
optional command registry). Pure ESM, Node ≥ 18.

## License & sources

MIT — see [LICENSE](LICENSE).

- [Go | OpenCode](https://opencode.ai/docs/go/) (model list + endpoint table)
- [OpenCode Go on Models.dev](https://models.dev/providers/opencode-go) (context/output/pricing)
- [Step 5 Preview](https://www.stepfun.com/step-5-preview) · [Step 5 API docs](https://platform.stepfun.ai/docs/en/guides/models/step-5-preview)
- [Discussion #3957](https://github.com/deepseek-ai/deepseek-harness/discussions/3957) (stale-catalog root cause)
- [Plugin authoring (dsh.pub)](https://dsh.pub/develop-plugin.md) · [Config & publishing](https://deepseekdocs.com/en/docs/learn/dev/config-publish)
- Live roster: `https://opencode.ai/zen/go/v1/models` · Registry: `https://models.opencode.ai/api.json`
