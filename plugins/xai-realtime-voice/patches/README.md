# Runtime patches for stock OpenClaw 2026.7.x

Stock OpenClaw 2026.7.x cannot run the wake-gated Discord voice experience
this plugin implements — several behaviours live in `@openclaw/discord`'s
compiled dist and are not reachable from config or the plugin SDK.
[`apply-runtime-patches.js`](apply-runtime-patches.js) patches them in place,
idempotently, with `--check` / `--json` modes for drift monitoring.

This is a **verbatim snapshot of the applier our fleet runs** (it is deploy
machinery there; the fleet copy is operationally canonical). Patches are
version-coupled to 2026.7.x — on newer OpenClaw releases, run `--check` and
read the report before trusting anything.

| Patch | Kind | What it fixes |
|-------|------|---------------|
| `wake-gate-xai` | bugfix | `requireWakeName` only activates for `provider.id === "openai"`; also allow `"xai"` |
| `capture-during-playback` | bugfix | With `bargeIn: false`, stock drops ALL mic capture while the AudioPlayer is playing — wake words over music went unheard |
| `wake-followup-ttl` | tuning | Post-wake follow-up window 10s → 60s |
| `speaker-context-recovery` | bugfix | Realtime consults could fire with no speaker context; recover pending/ignored-wake/last-known speaker |
| `local-whisper-wake-gate` | feature | Route `sendAudio` through the bridge's local wake buffer; `finalizeLocalWakeUtterance` on turn close — the hook this plugin's wake gate needs |
| `chillbot-all-speakers-full-tools` | **fleet policy** | Treats every guild speaker as owner for tools — keyed to `accountId === "chillbot"`, so it is **inert unless your Discord account id is literally `chillbot`**. Our trust model; read it before adopting the idea |
| `anthropic-sonnet5-cost-guard` | unrelated bugfix | Guards a crash when openclaw.json references `anthropic/claude-sonnet-5` without a cost object (breaks `models list` on 2026.7.1). Rides along because the applier is one file |

## Apply

Inside the OpenClaw container:

```bash
node patches/apply-runtime-patches.js          # apply
node patches/apply-runtime-patches.js --check  # report only (exit 2 = patches needed)
```

Then restart the gateway and rejoin voice. **Re-apply after every image update
or Discord-plugin reinstall** — dist files get replaced wholesale. We run an
hourly `--check`-then-apply guard for exactly that reason; something similar
is strongly recommended.
