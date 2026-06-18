#!/usr/bin/env node
/*
 * build-timeline.mjs — client-agnostic "scan run(s) → timeline.json" builder for
 * the `timeseries-radar-3d` skill.
 *
 * Reads one or more dated scan snapshots (axis scores + per-axis submetrics +
 * an action/causal ledger) and emits a timeline.json the radar consumes:
 *   - every dated snapshot becomes a real measurement (oldest → newest), so the
 *     orbit tube shows genuine history as runs accumulate;
 *   - the newest snapshot also contributes the `submetrics` map (drill-down),
 *     per-axis `detail` (band/confidence/highest-lift/day-one/caveat), and the
 *     `changes` causal ledger (from the action queue).
 *
 * It is config-driven so it isn't tied to any one scan shape. Defaults match the
 * SEO/GEO "seo-visibility" run shape (axis-scores.json + submetrics/<id>.json +
 * action-queue.json), but every path/field/axis-map is overridable via a config
 * JSON. This is the generalization of visibility-portal's build-cfp-data.mjs.
 *
 * Usage:
 *   node build-timeline.mjs --config <config.json> [--out timeline.json]
 *   node build-timeline.mjs --scan-root data/seo-visibility/<client> --out data/timeline.json
 *
 * Config JSON (all optional except scanRoot):
 *   {
 *     "scanRoot": "data/seo-visibility/cfp",   // dir holding dated snapshot dirs (+ optional current/)
 *     "out": "data/timeline.json",
 *     "title": "Acme — visibility over time",
 *     "client": { "slug": "acme", "name": "Acme" },
 *     "axisMap": { "<portalKey>": "<realAxisId>", … },   // realAxisId also = submetrics/<id>.json
 *     "files": { "axisScores": "axis-scores.json", "submetricsDir": "submetrics", "actionQueue": "action-queue.json" },
 *     "fields": {            // where to read values inside each scan record (dot-less, top-level keys)
 *       "axesArray": "axes", "axisId": "axis", "score": "score", "band": "position_band",
 *       "confidence": "confidence_state", "sourceWindow": "source_window",
 *       "highestLift": "highest_lift_submetric", "dayOneTactic": "day_one_tactic",
 *       "whatProves": "what_evidence_proves", "whatCannotProve": "what_evidence_cannot_prove",
 *       "runDate": "run_date"
 *     }
 *   }
 *
 * Heuristics you can rely on: a snapshot dir is "dated" if its name looks like a
 * date (YYYY-MM-DD…); `current/` is ignored for the time axis (it usually mirrors
 * the latest dated dir). Missing submetrics/action-queue degrade gracefully.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const DEFAULTS = {
  out: "data/timeline.json",
  files: { axisScores: "axis-scores.json", submetricsDir: "submetrics", actionQueue: "action-queue.json" },
  fields: {
    axesArray: "axes", axisId: "axis", score: "score", band: "position_band",
    confidence: "confidence_state", sourceWindow: "source_window",
    highestLift: "highest_lift_submetric", dayOneTactic: "day_one_tactic",
    whatProves: "what_evidence_proves", whatCannotProve: "what_evidence_cannot_prove",
    runDate: "run_date",
  },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }
function splitList(s) { return String(s || "").split(/;|·|,/).map((x) => x.trim()).filter(Boolean); }
const isDated = (name) => /^\d{4}-\d{2}-\d{2}/.test(name);
const isDone = (st) => /complete|verified|done|implemented/i.test(st || "");

// ---- load config ----
const cfgPath = arg("--config");
const cfg = { ...DEFAULTS, ...(cfgPath ? readJson(resolve(cfgPath)) : {}) };
cfg.files = { ...DEFAULTS.files, ...(cfg.files || {}) };
cfg.fields = { ...DEFAULTS.fields, ...(cfg.fields || {}) };
const scanRoot = resolve(arg("--scan-root", cfg.scanRoot || ""));
const outPath = resolve(arg("--out", cfg.out));
if (!scanRoot) { console.error("need scanRoot (in config or --scan-root)"); process.exit(1); }

const F = cfg.fields;
// axisMap: portalKey -> realAxisId. If omitted, derive identity map from the latest run's axes.
let axisMap = cfg.axisMap || null;
const realToPortal = () => Object.fromEntries(Object.entries(axisMap).map(([k, v]) => [v, k]));

// ---- find dated snapshots, oldest → newest ----
const snapDirs = readdirSync(scanRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && isDated(d.name))
  .map((d) => d.name).sort();
if (!snapDirs.length) { console.error(`no dated snapshots under ${scanRoot}`); process.exit(1); }
const latest = snapDirs[snapDirs.length - 1];

function axisRecords(snap) {
  const f = join(scanRoot, snap, cfg.files.axisScores);
  if (!existsSync(f)) return null;
  const j = readJson(f);
  return { runDate: j[F.runDate] || snap, axes: j[F.axesArray] || [] };
}

// derive axisMap + axes labels from the latest run if not provided
const latestRec = axisRecords(latest);
if (!latestRec) { console.error(`latest snapshot ${latest} has no ${cfg.files.axisScores}`); process.exit(1); }
if (!axisMap) axisMap = Object.fromEntries(latestRec.axes.map((a) => [a[F.axisId], a[F.axisId]]));
const axes = Object.entries(axisMap).map(([pk, realId]) => {
  const a = latestRec.axes.find((x) => x[F.axisId] === realId) || {};
  return { key: pk, label: a.label || pk };
});

// ---- measurements: one per dated snapshot ----
const measurements = snapDirs.map((snap) => {
  const rec = axisRecords(snap);
  const scores = {};
  for (const [pk, realId] of Object.entries(axisMap)) {
    const a = rec ? rec.axes.find((x) => x[F.axisId] === realId) : null;
    if (a) scores[pk] = a[F.score];
  }
  return { timestamp: rec ? rec.runDate : snap, real: true, scores };
});

// ---- enrich the newest measurement: detail + submetrics + changes ----
const newest = measurements[measurements.length - 1];
const r2p = realToPortal();
const detail = {};
for (const [pk, realId] of Object.entries(axisMap)) {
  const a = latestRec.axes.find((x) => x[F.axisId] === realId);
  if (!a) continue;
  detail[pk] = {
    band: a[F.band], confidence: a[F.confidence], sourceWindow: a[F.sourceWindow],
    highestLift: a[F.highestLift], dayOneTactic: a[F.dayOneTactic],
    whatProves: a[F.whatProves], whatCannotProve: a[F.whatCannotProve], notes: a.notes,
  };
}
newest.detail = detail;
if (latestRec.axes[0] && latestRec.axes[0][F.confidence]) newest.confidence = latestRec.axes[0][F.confidence];

const submetrics = {};
for (const [pk, realId] of Object.entries(axisMap)) {
  const f = join(scanRoot, latest, cfg.files.submetricsDir, `${realId}.json`);
  if (!existsSync(f)) continue;
  const j = readJson(f);
  submetrics[pk] = (j.submetrics || []).map((m) => ({
    key: m.submetric || m.key, label: m.label, score: m.score, weight: m.weight,
    confidence: m.confidence_state || m.confidence,
    evidenceSystems: splitList(m.evidence_systems), sourceExamples: splitList(m.source_metric_examples),
    improvementActions: m.improvement_actions, proofRequired: m.proof_required,
    history: submetricHistory(realId, m.submetric || m.key),
  }));
}

function submetricHistory(realId, submetricKey) {
  return snapDirs.map((snap) => {
    const f = join(scanRoot, snap, cfg.files.submetricsDir, `${realId}.json`);
    if (!existsSync(f)) return null;
    const j = readJson(f);
    const row = (j.submetrics || []).find((m) => (m.submetric || m.key) === submetricKey);
    return row ? row.score : null;
  });
}

const aqPath = join(scanRoot, latest, cfg.files.actionQueue);
if (existsSync(aqPath)) {
  const aq = readJson(aqPath);
  newest.changes = (aq.actions || []).map((a) => ({
    what: a.tactic || a.strategy || a.target_state || a.action_id,
    targets: r2p[a.axis] ? [r2p[a.axis]] : [],
    source: `action-queue#${a.action_id || ""}`,
    status: isDone(a.status) ? "confirmed" : "suggested",
    expected: "+",
  })).filter((c) => c.targets.length);
}

const out = {
  title: cfg.title || (cfg.client ? `${cfg.client.name} — visibility over time` : "Visibility over time"),
  ...(cfg.client ? { client: cfg.client } : {}),
  axes, submetrics, measurements,
};
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
const avg = Math.round(Object.values(newest.scores).reduce((s, v) => s + v, 0) / (Object.keys(newest.scores).length || 1));
console.log(`✓ ${outPath}`);
console.log(`  ${axes.length} axes · ${measurements.length} measurement(s) [${snapDirs[0]}…${latest}] · newest avg ${avg} · ${Object.values(submetrics).reduce((n, a) => n + a.length, 0)} submetrics · ${(newest.changes || []).length} changes`);
