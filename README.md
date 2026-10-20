# dsh-opencode-go-catalog

A live-maintained OpenCode Go model catalog for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH). Membership is rebuilt from the live roster plus the docs endpoint table on every sync — new
models appear, retired ones drop out, no hand work. A curated snapshot stays as the offline fallback.

**Status:** 0.2.0 · auto membership · 33 models live (2026-10-13), incl. **Cat Jam Free** (`cat-jam-free`)

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands & scripts](#commands--scripts)
- [Fresh reasoning efforts](#fresh-reasoning-efforts)
- [The protocol oracle](#the-protocol-oracle)
- [Maintaining the catalog](#maintaining-the-catalog)
- [Enable / disable](#enable--disable)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Compatibility](#compatibility)
- [License & sources](#license--sources)

## Why

The built-in `opencode-go` route of `@deepseek-ai/dsh-llm-pi-ai` serves a static catalog shipped in
`@earendil-works/pi-ai` (30 models at the time of writing) that never refreshes itself — new models
like Step 5 or Cat Jam are missing until upstream bumps the dependency. See
[Discussion #3957](https://github.com/deepseek-ai/deepseek-harness/discussions/3957).

This plugin never touches the built-in route. It manages three sibling routes through the
official `settings.mutate` seam:

| Route | Protocol | Examples |
|---|---|---|
| `opencode-go-extras` | `openai-completions` | Cat Jam Free, Step 5 Preview Free, GLM-5.3, LongCat, MiMo, Kimi, DeepSeek |
| `opencode-go-responses` | `openai-responses` | GPT-5.6/6 Luna, Grok 4.6/4.7, Muse Spark 1.2/1.3 |
| `opencode-go-messages` | `anthropic-messages` | Claude Haiku 5.5, Qwen3.8, MiniMax M2.7/M3 |

The split is mandatory, not stylistic: some Go models are *Responses-only* (a chat-completions
request answers with a bare `500` or `401 "not supported for format oa-compat"`), others are
*Messages-only*. One route = one protocol.

**Why not put the extra models on the built-in route?** Source-verified against `dsh-llm-pi-ai`:
`resolveRouteModels` computes a model's protocol as `request.api ?? base?.api ?? routeApi` — an
`api` field *on a model entry* is never read. A model the shipped catalog does not describe
therefore needs the **route-level** `api`, and setting that routes `opencode-go` through
`createProvider()` over a *single* protocol (the catalog provider is only reused while
`spec.api === undefined`), losing both the three-protocol dispatch and pi-ai's session-header
wrapper. On top of that, any `models` list *replaces* the served catalog. The built-in route stays
untouched.

## How it works

1. **Registry** — `https://models.opencode.ai/api.json` (keyless, ETag cache + last-good fallback)
   supplies name, limits, input modalities, and `reasoning_options` per model.
2. **Roster** — `https://opencode.ai/zen/go/v1/models` (keyless) says which IDs exist *right now*.
3. **Protocol oracle** — `https://opencode.ai/docs/go/` (since 2026-10-19 redirecting to
   `/v2/docs/console/go/`) carries an endpoint table per model ID in either path shape
   (`…/go/v1/chat/completions` or `…/go/<lane>/v1/chat/completions`, plus `/responses` and
   `/messages`). See [The protocol oracle](#the-protocol-oracle).
4. Membership is then `roster ∩ registry ∩ protocol-known`, minus the veto list. On startup, on an
   interval (default 4 h), and on `/opencode-go-sync` the three sibling routes are written via
   `settings.mutate`.
5. **Fail-safe.** The auto mode refuses to write, and the curated snapshot in `catalog/models.json`
   is served unchanged, when
   - the roster or the oracle is unavailable (network, docs redesign), or
   - fewer than `minAutoModels` models resolve, or
   - fewer than `minAutoRatio` (default 60 %) of the last adopted set resolve — this catches a
     *degraded* source that would otherwise quietly empty half the picker and stamp the missing IDs
     as retired.

   A single route that comes out empty is not fatal either: `llm-pi-ai` rejects a route with
   `resolves no models`, and because all three routes go into one `settings.mutate`, one empty group
   would block the healthy groups too — so that route is served from the snapshot and reported in
   `status.json` (`auto.snapshotRoutes`). A network outage or a docs redesign can therefore never
   empty the picker. Missing capacities are never invented — the field is omitted and `needsReview`
   is reported, so `llm-pi-ai` applies its own route defaults (262144 / 32768).
6. The module never throws during boot, never edits `node_modules`, and never reads or writes
   credentials (it only references the `OPENCODE_GO_API_KEY` name, same as the built-in route).

**Hand-added models do not survive.** `settings.mutate` persists into the profile's
`cordis.patch.yml`, and each sibling route is written as one whole object. A model you add by hand
(or via Settings → Models → *Fetch available models* → *Add model*) inside one of these three routes
is gone at the next sync — startup, interval, or `/opencode-go-sync`. Durable entries belong in the
snapshot (`node bin/sync.mjs --adopt`) or in the veto list.

## Installation

Prerequisites: DSH running, an OpenCode Go subscription with a working key
(`OPENCODE_GO_API_KEY` already configured — if the built-in `opencode-go` route works, you are set).

**Via Plugin Market** (once listed): Settings → Plugin Market → search
`dsh-opencode-go-catalog` → one-click install → restart → open the model picker.
Expect three new groups (*OpenCode Go extras / responses / messages*) next to the built-in one.

**Manual**: copy this folder to `<profile>/node_modules/dsh-opencode-go-catalog`, add
`"dsh-opencode-go-catalog"` to `dsh.profile.bundles` in the profile `package.json` (keep a backup
first), restart DSH.

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
    autoMembership: true     # false → curated snapshot only, no roster/oracle
    minAutoModels: 8         # safety belt: below this the snapshot is served
    minProtocolRows: 10      # safety belt against a docs redesign
    minAutoRatio: 0.6        # safety belt against a degraded (not dead) source; 0 disables it
    refreshReasoning: true   # false → snapshot values only, no network (this also disables auto mode)
    sessionHeaderValue: 'dsh-opencode-go-catalog'  # false → no static session header (400 risk)
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
| `/opencode-go-sync` (chat) | Immediate rewrite from the live sources. Registered through `ctx.root` into the global command layer, so it appears in the `/` menu for every session (registering through the plugin fiber context lands outside all agent scope chains: self-probe green, menu empty — fixed in 0.1.4) |
| `node bin/sync.mjs` (default) | Report: field diffs, new live IDs with their protocol, dead IDs — writes nothing |
| `node bin/sync.mjs --auto` | Preview what the auto mode would publish (per route, added, removed, unresolved). Uses the default safety belts — a non-default `minAutoModels`/`minAutoRatio`/`minProtocolRows` in the profile patch can make the host decide differently |
| `node bin/sync.mjs --adopt` | Write the live membership into the snapshot (fallback stays current) |
| `node bin/sync.mjs --write` | Rewrite snapshot fields from the registry + stamp the date |
| `node bin/sync.mjs --check` | Offline snapshot rule check |
| `node bin/snippet.mjs` | Print the complete `llm-pi-ai` replacement row for manual installs |
| `node verify.mjs` | Manifest + patch shape + catalog rules + fixture tests for oracle and auto builder (offline) |

## Fresh reasoning efforts

`reasoning_options` in the live registry are structured (`effort` values, `toggle`, `budget_tokens`)
— Models.dev serves the same data. Mapping rules ([lib/reasoning.mjs](lib/reasoning.mjs)):

| Registry | pi-ai `reasoningEfforts` |
|---|---|
| `effort` values (`low`, `medium`, …) | Identity mapping (`low: low`, …) |
| `none` value | `off: none` |
| `toggle`-only / `budget_tokens`-only / empty array | **no** block (never invent a menu — the picker would lie) |
| `toggle` + `effort` combined | `effort` wins |
| `modalities.input` containing `image` | `input: [text, image]` (pi-ai only knows `text`/`image`; `video`/`audio`/`pdf` are dropped documented) |

Live examples: Cat Jam Free → `{low, medium, high, xhigh, max}`; GPT-5.6 Luna →
`{off: none, low…max}`; Muse Spark → `{minimal…xhigh}` (no `max`!); LongCat-2.0 /
MiniMax M3 (`toggle`-only) → no menu.

## The protocol oracle

No JSON endpoint discloses the **wire endpoint** per model, but the registry names the **lane** per
model in the top-level `opencode-go` section, `models[<id>].provider.api`
(`…/inference/go/openai/v1`, `…/inference/go/anthropic/v1` or `…/inference/go/google/v1beta`;
33/33 entries on 2026-10-19, 0 contradictions with the table below). The lane settles `anthropic` and
`google` on its own but is ambiguous inside the OpenAI lane (`chat/completions` vs `responses`), so
the docs table stays the oracle for that split. Using the lane as a second, path-independent oracle
is tracked in [#10](https://github.com/AincradLabs/dsh-opencode-go-catalog/issues/10).

| Source | Verdict |
|---|---|
| `https://opencode.ai/docs/go/` endpoint table | **oracle** — 33 rows on 2026-10-13, 28 rows on 2026-10-19 (v2 page) |
| Registry `provider.api` lane | corroborates the table (anthropic lane ↔ `anthropic-messages`); ambiguous inside the OpenAI lane |
| Hand-calibrated snapshot | 0 conflicts with the table |
| Shipped pi-ai catalog (`data/opencode-go.json`) | **not usable** — contradicts the table on `minimax-m2.7`, `qwen3.7-plus`, `qwen3.8-max` |

`lib/protocols.mjs` parses the table (`htmlToText` + one row regex) and filters every hit against
the live roster, so a regex false positive can never invent a model ID. The row regex anchors on a
Go inference **path**, not a host, and accepts both documented URL shapes. It also reads the SDK
column (`@ai-sdk/openai-compatible` / `openai` / `anthropic`) as a cross-check: `@ai-sdk/openai`
serves both OpenAI endpoints, so only a statement that excludes the parsed endpoint counts as a
contradiction — then that ID leaves the oracle and is reported under `auto.conflicts`. An unknown
endpoint suffix is never rescued by the SDK column: a new endpoint type (e.g. `/embeddings`) must not
land in a chat route. An ID without a table row is **not guessed** — it is reported as `unresolved`
in `status.json` and stays out. Current examples: `qwen3.6-plus`, `qwen3.7-max`, `glm-5.1`,
`omen-alpha`, `gemini-4-argon-contributor` (live, undocumented).

**Row dropped from the docs (carry-over, 2026-10-19).** The v2 table no longer lists every live ID
(`minimax-m2.7` is the example). For such an ID the protocol already verified in the snapshot applies
again — no heuristic, but second-hand, so it is reported under `auto.carried`. The committed snapshot
is the evidence source on purpose; the cache keeps only rows a live read actually produced. A rejected
ID is excluded from the carry-over as well: a contradiction is not a gap.

**Silent-staleness guard.** If the page stops yielding at least `minProtocolRows` rows, the last-good
cached table is used and `auto.degraded` is set with `auto.degradedReason: "shape"`; the host logs a
warning naming the redirect target, because in this state new Go models silently stay out of the
picker. This is exactly what happened between the v2 docs redesign (`/go/v1/…` →
`/go/<lane>/v1/…`) and the regex fix on 2026-10-19. A network failure keeps the same cache but is
reported as `degradedReason: "network"` — it is not a docs-format problem. A row that contradicts
another row for the same ID takes that ID out of the oracle entirely (keeping the first would be a
guess) and is reported under `auto.conflicts` in `status.json`.

## Maintaining the catalog

Normally nothing: the auto mode is the maintenance. The snapshot only needs attention when you want
to pin something or keep the fallback current:

1. `node bin/sync.mjs --auto` — see what the live sources currently produce.
2. `node bin/sync.mjs --adopt` — take the live membership into `catalog/models.json` (also moves
   vanished IDs into `retired`). Run it after a model appears or disappears, so an offline start
   serves the same list.
3. To keep a live model *out* of the picker, list it in `excluded` with a reason.
4. `node verify.mjs` → `/opencode-go-sync`.

## Enable / disable

- **Siblings off, plugin stays loaded:** add your own `- id: opencode-go-catalog` row
  (with the FULL config — patches replace, never merge; copy
  [cordis.patch.yml](cordis.patch.yml) as the template) to your profile patch with
  `enabled: false`. The three routes are removed again via unset ops; the built-in
  `opencode-go` route keeps running untouched.
- **Auto mode off, curated snapshot on:** `autoMembership: false`.
- **Whole plugin off:** `disabled: true` on the bundle row (or the market's disable
  list), restart. Nothing needs deleting.

## Session header (MissingSessionID-400)

OpenCode Go requires `x-opencode-session` (stable per-conversation ID) since 09/05 —
see [Discussion #5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495).

Refined 2026-10-13, source-verified: `dsh-llm-pi-ai` **does** forward a per-conversation id
(`…options.sessionId === void 0 ? {} : { sessionId: String(options.sessionId) }`), and pi-ai's
catalog provider wraps its APIs with `withOpenCodeSessionHeader`, which reads exactly that
`sessionId`. The gap is narrower than "the adapter has no sessionHeader": **hand-declared routes
never pass through that wrapper**, because `createProvider` calls the raw protocol factory. So a
sibling route still needs the static header below.

Until a declared route can opt into the wrapper, this plugin sets a **static** header on every
sibling route (`sessionHeaderValue`, default `'dsh-opencode-go-catalog'`, off with `false`).
Trade-off, stated plainly: one fixed ID across all conversations means fewer cache hits — slower and
pricier than a proper per-conversation ID (user-verified). It beats a hard `400`. The built-in
`opencode-go` route is never touched (it gets the real per-conversation header from pi-ai itself).
Upstream: `earendil-works/pi#9326` — the ask is "apply `withOpenCodeSessionHeader` to declared
routes too", not "add sessionId to the adapter".

## Diagnostics

After every sync attempt the plugin writes `status.json` next to `package.json` (time, ok, via,
changed, command, fetch, error, and for auto mode: `roster`/`protocols` source, `members`,
`perRoute`, `added`, `removed`, `unresolved`, `vetoed`, `needsReview`). Open it in any editor — no
log access needed. If the picker stays empty, send this file's content with your report.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| New model missing from the picker | Not in the roster, or no protocol row in the docs table | Check `status.json` → `auto.unresolved`; a live-but-undocumented model needs a probe before it can be adopted |
| Model disappeared after a restart | It was added by hand to one of the three managed routes | Durable entries go into the snapshot (`--adopt`) or the veto list |
| Model answers `500` / `401 not supported for format` | Wrong protocol (e.g. a Responses-only model on a completions route) | Fix the oracle source or move it in the snapshot; `--auto` shows the current assignment |
| Picker suddenly much smaller | Roster/oracle unreachable and the snapshot is stale | `status.json` → `fetch`/`auto`; run `node bin/sync.mjs --adopt` while online |
| `model '…' needs an api` | Hand-declared route without `api` | Set `api` + `baseURL` + non-empty `models` (the plugin does this automatically) |
| Images rejected before sending | `input` is `[text]` | Set `input: [text, image]` per model (only with proven vision support) |
| No effort menu | `reasoningEfforts` missing | Adopt from the registry's `reasoning_options`; mind `off: none` vs empty `off` |
| `400 MissingSessionID` | Gateway needs `x-opencode-session`, declared routes get no wrapper | Plugin sets a static one per sibling route (see above) |
| Installed but seemingly idle | — | This plugin uses no shell hooks; check `status.json` next to `package.json` |
| Install gate refuses | Peer range with stable lower bound | Not applicable here (no `@deepseek-ai/dsh*` peers declared on purpose) |

Never hand-edit `node_modules/…/pi-ai/dist/providers/data/opencode-go.json` — the next DSH
update discards it silently. This snapshot is the place.

## Security

- **No secrets:** the plugin never reads, writes, logs, or ships credentials. `OPENCODE_GO_API_KEY`
  appears only as a *name reference*, exactly like the built-in route. Verified by pre-commit sweep.
- **Network:** only three public, keyless endpoints (`models.opencode.ai/api.json`,
  `opencode.ai/zen/go/v1/models`, `opencode.ai/docs/go/`), each with timeout + cache + offline
  fallback to snapshot values.
- **Zero dependencies**, no `@deepseek-ai/dsh*` peers (the install gate cannot refuse it),
  no shell hooks, fail-safe boot.

## Compatibility

Built against DSH `0.2.0-rc.2` behavior (static pi-ai catalog, `settings.mutate` seam, optional
command registry). Pure ESM, Node ≥ 18.

## License & sources

MIT — see [LICENSE](LICENSE).

- [Go | OpenCode](https://opencode.ai/docs/go/) (model list + endpoint table)
- [OpenCode Go on Models.dev](https://models.dev/providers/opencode-go) (context/output/pricing)
- [Step 5 Preview](https://www.stepfun.com/step-5-preview) · [Step 5 API docs](https://platform.stepfun.ai/docs/en/guides/models/step-5-preview)
- [Discussion #3957](https://github.com/deepseek-ai/deepseek-harness/discussions/3957) (stale-catalog root cause)
- [Discussion #5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495) (session header)
- [Plugin authoring (dsh.pub)](https://dsh.pub/develop-plugin.md) · [Config & publishing](https://deepseekdocs.com/en/docs/learn/dev/config-publish)
- Live roster: `https://opencode.ai/zen/go/v1/models` · Registry: `https://models.opencode.ai/api.json`
