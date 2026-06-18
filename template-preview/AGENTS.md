# Agent instructions — client visibility report repo

This repo is instantiated from `client-visibility-report-template` for ONE client.
Hold these expectations on every run.

## State separation (do not collapse into "fixed")
`prepared` → `implemented` → `deployed` → `live` → `provider_connected` →
`first_rows_present` → `verified_after_rerun` → `closed` are separate states.
A score moves only with evidence; never narrate around a missing metric — collect it.

## Data discipline
- Only THIS client's data lives here (isolation by construction).
- `data/timeline.json` (and any `data/<client>/...`) MUST be committed and served at the
  deployed Pages path; verify it returns 200 from the deployed origin, not just locally.
- Keep dated snapshots so trends are real and reproducible.

## The framework layer is shared — don't fork it
- `framework/` (radar, builder, gates) is synced from the template. Improve it THERE,
  then `framework-sync` into here. Do not hand-edit `framework/` locally except as a
  stopgap you immediately upstream.

## Gates before "live" (run framework/gates + the radar's own checks)
- Radar renders with no console errors; drill-down opens; mobile + desktop screenshots captured.
- `data/timeline.json` valid + served 200 at the deployed path.
- Scores trace to evidence; confidence/`detail` reflect real provider state, not assumed.
- Ladder: committed ≠ pushed ≠ deployed ≠ rendering-live-with-data. Verify the last rung.

## Boundaries
No provider credentials, cookies, tokens, client PII, or raw admin backups in this repo.
Do not create remotes, publish Pages, mutate provider/CMS/DNS, or close issues without
explicit approval.
