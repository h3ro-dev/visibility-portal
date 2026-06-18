# Client Visibility Report — template

The scaffolding repo for a client SEO/GEO/GDO visibility engagement. Every client
gets a copy of this; the expectations (radar, 12-axis scorecard, data discipline,
gates) are built in so a new engagement starts production-shaped, not from scratch.

**This is a GitHub _template repository_.** Don't commit client work here — instantiate
a per-client repo from it (see "New client" below).

## Layout

```
index.html              # renders the radar from data/timeline.json (+ CLIENT.json title)
CLIENT.json             # { slug, name, domain } — filled by bootstrap per client
data/timeline.json      # the radar's data: 12-axis scores over time + submetrics
framework/              # the SHARED, syncable layer — single source of improvements
  VERSION               # bump when the framework changes; client repos sync to it
  radar/scan-radar3d.*  # the timeseries-radar-3d component (dependency-free)
  build-timeline.mjs    # scan run(s) -> timeline.json
  gates/                # verification/gate scripts every client repo must pass
scripts/
  bootstrap.mjs         # one-time: adjust this repo for a specific client
  framework-sync.mjs    # pull the latest framework/ from the template (propagation)
_config.yml .nojekyll   # GitHub Pages config
```

## New client (instantiate)

Driven by the `project-scan-buildout` skill (`scripts/new-client.sh`), which:
1. `gh repo create <slug>-visibility-report --template <org>/client-visibility-report-template --private`
2. clones it, runs `node scripts/bootstrap.mjs <slug> "<Name>" <domain>`
3. builds the first `data/timeline.json` (`framework/build-timeline.mjs`), runs the gates, commits, enables Pages.

## Improving the framework (propagation)

The `framework/` layer is the single source of truth. When the radar/builder/gates
improve **here**, bump `framework/VERSION`, then in each existing client repo run
`node scripts/framework-sync.mjs --from <template-checkout>` + re-run the gates + commit.
New clients get the latest automatically at instantiation. This is what makes
gating + improvements easy to delegate across every client.

## Data discipline

Only this client's data ever lives in a client repo (isolation by construction).
The `data/timeline.json` must be committed and served at its deployed Pages path —
verify it returns 200 from the deployed origin, not just locally.
