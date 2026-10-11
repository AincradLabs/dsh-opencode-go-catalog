# Beginner install — Step 5 & friends in 10 minutes

No prior knowledge needed. You paste one ready-made text block in one place, restart, done.

**Time:** ~10 minutes · **Risk:** none — with the backup, everything is undone in 1 minute.

## Check first (30 seconds)

- [ ] DeepSeek Harness runs and you have used a model via OpenCode Go before
      (then your key is already configured — no key hunting needed).
- [ ] You can open a file in an editor and save it. That's all.

## Step 1 — Backup (1 minute)

1. Open the folder `$DSH_HOME/profiles/<your-profile>/`
   (e.g. `~/.dsh/profiles/desktop/`).
2. Copy `cordis.patch.yml` to `cordis.patch.yml.backup`. Done.
   If anything ever goes wrong: rename the backup back, restart — everything as before.

## Step 2 — Insert the ready-made block (3 minutes)

1. Open [weg-a-schnellstart.yml](weg-a-schnellstart.yml) from this repo in an editor
   and copy **everything** (Ctrl+A, Ctrl+C). Regenerate it any time with:
   `node bin/snippet.mjs > weg-a-schnellstart.yml`
2. Open `$DSH_HOME/profiles/<your-profile>/cordis.patch.yml`.
3. Find the section starting with:
   ```yaml
   - id: llm-pi-ai
   ```
   It runs until just before the next `- id:` or `- insert:` section (it currently holds
   only `opencode-go` with `apiKeyEnv` — exactly what we replace).
4. Delete that one section **completely** and paste the copied block in its place (Ctrl+V).
5. Save. Change nothing else!

> Why replace wholesale? This file follows "last version wins, nothing is merged
> automatically". So the ready-made block already contains your old setting — nothing is lost.

## Step 3 — Restart (2 minutes)

Quit DeepSeek Harness **fully** and open it again (just closing the window is sometimes not
enough). On startup it reads the changed file.

## Step 4 — Verify (1 minute)

1. Open the model picker (where you usually switch models).
2. You now see **three new groups**: *OpenCode Go (extras)*, *OpenCode Go (responses)*,
   *OpenCode Go (messages)* — in addition to the existing group.
3. Type `step-5` in the search: **Step 5 Preview Free** appears. Select it, ask a short
   question — if it answers, you're done. 🎉

## On / off

- **Try individually:** just pick another model in the picker — the new groups don't disturb anything.
- **Remove everything:** rename `cordis.patch.yml.backup` from step 1 back to
  `cordis.patch.yml` (overwriting the current one), restart. Gone without a trace.

## If something doesn't work

| What you see | What it means | What to do |
|---|---|---|
| New groups missing | File not saved or not restarted | Check saving, quit the harness fully and reopen |
| Startup error about an invalid file | A line slipped while pasting | Restore the backup, calmly repeat step 2 |
| A new model answers `500` or `not supported` | Wrong subgroup (happens, harmless) | Note model + exact message and file an issue — we'll re-sort it |
| Anything else | — | Restore the backup (everything runs as before) and file an issue |

## And the plugin with auto-refresh?

That's the main path (see [README.md](README.md)): it writes these three groups freshly by
itself. It needs a one-click install via the Plugin Market first, which requires a catalog
listing — in progress. **This snippet is no throwaway:** the exact same 19 models with the
same fresh values — only the automatic upkeep is missing. When models go missing again,
regenerate the block and repeat steps 2–4.
