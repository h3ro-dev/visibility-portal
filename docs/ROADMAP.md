# Visibility Portal — Roadmap & Handoff

A WebGL time-series radar ("conic"). **Face-on** = full per-axis detail (the CFP-portal
scorecard). **Orbited** = a 3D tube of every measurement stacked along depth=time, with a
causal panel (per-axis deltas + the changes made that window).

## Current state (working, live)

- **Repo:** github.com/h3ro-dev/visibility-portal (public) · local: `~/Projects/visibility-portal/`
- **Live:** https://h3ro-dev.github.io/visibility-portal/ (GitHub Pages, `main`/root)
- **Works:** face-on detail (centered radar + 12 axis chips w/ scores), orbit via drag or the **3D time series** button (chips fade, clean tube), causal side panel, timestamp chips, **canvas fallback** when WebGL is unavailable. Synthetic data in `data/timeline.sample.json`.
- **Component:** `assets/radar3d.js` (Three.js via CDN importmap + canvas fallback) + `assets/radar3d.css`.
- **Sibling skills repo:** github.com/h3ro-dev/scan-buildout-skills (`internal-dashboard-ui`, `project-scan-buildout`, `timeseries-radar-3d`), symlinked into `~/.codex/skills` + `~/.claude/skills`.

## Verification setup (READ FIRST — hard-won)

The headless sandbox has **no WebGL**, so the 3D is verified by driving James's real Chrome via the **Claude-in-Chrome extension** against the **public Pages URL**.
- His Chrome **cannot reach the sandbox's localhost/LAN** (different host/proxy; LAN IP returns "unreachable") → must use the public Pages URL.
- Extension must be signed into the **same claude.ai account as Claude Code** (a `James@utlyze.com` vs `Studio@utlyze.com` mismatch blocked pairing; needs a full Chrome restart after switching).
- **Loop:** edit → commit/push → `gh api -X POST repos/h3ro-dev/visibility-portal/pages/builds` → bump `?v=` on the asset links in `index.html` → poll until the new asset is served → navigate the extension tab to the Pages URL → screenshot. (Pages/CDN caches; the `?v=` bump is what busts it.)
- Local IPv4 gotcha (if ever serving locally for the *fallback*): `python3 -m http.server --bind 0.0.0.0` (default binds IPv6, which Chrome's `localhost`/`127.0.0.1` may refuse).

## Data contract (`timeline.json`)

```json
{ "title": "…",
  "axes": [{ "key": "aigeo", "label": "AI / GEO" }, … N],
  "measurements": [{
    "timestamp": "2026-06-15", "label": "…",
    "scores": { "aigeo": 62, … one 0–100 per axis key },
    "changes": [{ "what": "FAQ schema on 8 pages", "targets": ["aigeo","proof"],
                  "source": "action-queue#37", "status": "confirmed|suggested", "expected": "+" }]
  }, …] }
```
`measurements` = the time axis (oldest→newest, newest renders front). `changes` = the causal ledger for that measurement vs the prior one.

## Phases

- **A — Finish the artifact:** 3D polish, face-on detail parity with the CFP portal, accessibility.
- **B — Data + builder:** finalize the contract; build the CFP timeline builder (auto-suggest the causal ledger from CFP's per-run data); backfill history.
- **C — Multi-client portal:** central store, internal navigator, per-client client-facing pages (isolated by construction).
- **D — Templated repo + skills:** make this a templated repo; break `scan-buildout-skills` into finer skills.

## Issues (see GitHub for live tracking)

1. **Smooth face-on⇄orbit fly** (no blank). Eased camera move that doesn't fight OrbitControls (disable controls during the tween, sync after). *Done = animated transition both ways, tube never disappears, chips fade correctly.*
2. **Face-on detail parity with the CFP portal.** Bring the portal's richness into the overlay: eye-tooltips, axis-brief/submetric panel, progress bars, gaps/proof line. *Done = face-on reads like cfp-seo-geo-visibility-score.html.*
3. **3D quality pass.** Lighting/materials, ring spacing + on-tube axis labels, zoom limits, verified touch-orbit on mobile. *Done = screenshots at desktop+mobile look polished; orbit smooth on touch.*
4. **Accessibility.** `prefers-reduced-motion` (no auto-spin/animation), keyboard nav, ARIA for canvas + overlay, chip contrast ≥ AA. *Done = passes a basic a11y pass.*
5. **Finalize `timeline.json` + JSON schema + validator.** *Done = schema file + a validate script; sample passes.*
6. **CFP timeline builder.** Read CFP per-run data (`axis-scores`, `action-queue`, `causal-hypotheses`, `second-pass-actions`) → emit `timeline.json` with auto-suggested `changes` (status `suggested`) to confirm; backfill historical snapshots. *Done = real CFP timeline renders; suggestions appear.*
7. **Multi-client store + internal navigator.** `data/clients/<id>/timeline.json` + `clients.json`; an internal page to pick a client and load its artifact. *Done = click-through across ≥2 clients.*
8. **Per-client client-facing generator.** Build static per-client bundles containing only that client's data + client-safe fields (isolation by construction, not client-side filtering); decide private hosting/auth. *Done = a client bundle contains no other client's data.*
9. **Templated repo + broken-out skills.** Make visibility-portal instantiable; split `scan-buildout-skills` into: radar artifact, multi-client store/schema, portal scaffold+generator, deploy. *Done = a fresh program can be scaffolded from the template + skills.*

## Copy-paste: start a new thread

> Continuing the **visibility-portal** project — a WebGL time-series radar that shows a scan's per-axis scores face-on (CFP-portal detail) and, orbited, a 3D tube of measurements stacked over time, with a causal panel.
>
> **State:** repo `github.com/h3ro-dev/visibility-portal` (public), live at `https://h3ro-dev.github.io/visibility-portal/`, local `~/Projects/visibility-portal/`. Component is `assets/radar3d.js` (Three.js via CDN + canvas fallback) + `assets/radar3d.css`; sample data `data/timeline.sample.json`. Working: face-on detail, orbit (chips fade), causal panel, fallback.
>
> **Verification (do this first):** I can't render WebGL in my sandbox — verify by driving James's real Chrome via the Claude-in-Chrome extension against the **public Pages URL** (his Chrome can't reach my localhost). Extension must be on the **same claude.ai account** as this session. Loop: edit → push → `gh api -X POST repos/h3ro-dev/visibility-portal/pages/builds` → bump `?v=` on the asset links → poll until live → navigate the extension tab → screenshot.
>
> **Read `docs/ROADMAP.md` and the open issues at `github.com/h3ro-dev/visibility-portal/issues`, confirm the extension is connected on the right account, then start with issue #1 (smooth face-on⇄orbit fly).** Keep the sibling skills repo (`h3ro-dev/scan-buildout-skills`, symlinked into `~/.codex/skills` + `~/.claude/skills`) in mind for Phase D.
