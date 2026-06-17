#!/usr/bin/env node
/*
 * build-cfp-data.mjs — turn a real CFP visibility run into the portal's data file.
 *
 * Reads a CFP seo-visibility run (axis-scores + per-axis submetrics + action-queue)
 * and emits data/timeline.cfp.json:
 *   - older measurements = the synthetic demo history (so the orbit tube still has
 *     depth) — these stay clearly marked demo until real weekly runs accumulate;
 *   - the NEWEST measurement = the real CFP scores, real causal ledger (action-queue),
 *     a confidence state, and a per-axis `detail` block;
 *   - a top-level `submetrics` map (axis key -> [submetric…]) powering the drill-down.
 *
 * Usage:  node scripts/build-cfp-data.mjs [path-to-cfp-repo] [client-slug]
 * Default cfp repo: ../cfp-parity-and-beyond   ·  default slug: cfp
 *
 * This is the seed of issue #6 (CFP timeline builder); for now it backfills one real
 * run into a demo timeline. Run locally and commit the emitted JSON.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const CFP = resolve(REPO, process.argv[2] || "../cfp-parity-and-beyond");
const SLUG = process.argv[3] || "cfp";
const RUN = resolve(CFP, "data/seo-visibility", SLUG, "current");

// portal axis key  ->  real CFP axis id (also the submetrics/<id>.json filename)
const AXIS_MAP = {
  access:      "access_and_toolbelt_readiness",
  crawl:       "crawl_and_index_architecture",
  ia:          "information_architecture_internal_links",
  demand:      "demand_and_content_opportunity",
  proof:       "content_proof_eeat",
  authority:   "authority_and_offsite_corroboration",
  local:       "local_entity_reputation",
  aigeo:       "ai_geo_visibility",
  perf:        "performance_and_ux",
  trust:       "accessibility_quality_security_trust",
  cro:         "cro_and_behavior_intelligence",
  attribution: "attribution_monitoring_reporting_governance",
};
const REAL_TO_PORTAL = Object.fromEntries(Object.entries(AXIS_MAP).map(([k, v]) => [v, k]));

const readJson = (p) => JSON.parse(readFileSync(resolve(RUN, p), "utf8"));
const splitList = (s) => String(s || "").split(/;|·|,/).map((x) => x.trim()).filter(Boolean);

const axisScores = readJson("axis-scores.json");
const actionQueue = readJson("action-queue.json");
const byRealAxis = Object.fromEntries(axisScores.axes.map((a) => [a.axis, a]));

// --- per-axis detail + scores (portal keys) ---
const scores = {};
const detail = {};
for (const [pk, realId] of Object.entries(AXIS_MAP)) {
  const a = byRealAxis[realId];
  if (!a) { console.warn(`! missing axis ${realId}`); continue; }
  scores[pk] = a.score;
  detail[pk] = {
    band: a.position_band,
    confidence: a.confidence_state,
    sourceWindow: a.source_window,
    highestLift: a.highest_lift_submetric,
    dayOneTactic: a.day_one_tactic,
    proofRequired: a.proof_required,
    whatProves: a.what_evidence_proves,
    whatCannotProve: a.what_evidence_cannot_prove,
    notes: a.notes,
  };
}

// --- submetrics map (the drill-down sub-spider data) ---
const submetrics = {};
for (const [pk, realId] of Object.entries(AXIS_MAP)) {
  let s;
  try { s = readJson(`submetrics/${realId}.json`); }
  catch { console.warn(`! no submetrics for ${realId}`); continue; }
  submetrics[pk] = (s.submetrics || []).map((m) => ({
    key: m.submetric,
    label: m.label,
    score: m.score,
    weight: m.weight,
    confidence: m.confidence_state,
    evidenceSystems: splitList(m.evidence_systems),
    sourceExamples: splitList(m.source_metric_examples),
    improvementActions: m.improvement_actions,
    proofRequired: m.proof_required,
  }));
}

// --- real causal ledger from the action queue (-> timeline `changes`) ---
const isDone = (st) => /complete|verified|done|implemented/i.test(st || "");
const changes = actionQueue.actions.map((a) => ({
  what: a.tactic || a.strategy || a.target_state || a.action_id,
  targets: REAL_TO_PORTAL[a.axis] ? [REAL_TO_PORTAL[a.axis]] : [],
  source: `action-queue#${a.action_id}`,
  status: isDone(a.status) ? "confirmed" : "suggested",
  expected: "+",
})).filter((c) => c.targets.length);

// --- compose: demo history + real newest measurement ---
const demo = JSON.parse(readFileSync(resolve(REPO, "data/timeline.sample.json"), "utf8"));
const out = {
  title: "Commercial Funding Partners — visibility over time",
  client: { slug: SLUG, name: "Commercial Funding Partners" },
  axes: demo.axes,
  submetrics,
  measurements: demo.measurements.map((m, i, arr) => {
    if (i !== arr.length - 1) return { ...m, synthetic: true };   // demo history (tube)
    return {                                                       // real newest (face-on)
      timestamp: axisScores.run_date,
      label: "Live CFP run",
      real: true,
      confidence: "partial_provider_verified",
      scores,
      detail,
      changes,
    };
  }),
};

// Per-submetric history for the drill-down's "mountain range". Only the newest
// submetric values are real (one run so far); earlier points are synthetic demo
// backfill (consistent with the demo-history rings), ending at the real score.
const HM = out.measurements.length;
for (const pk of Object.keys(submetrics)) {
  submetrics[pk].forEach((sm, j) => {
    const s = sm.score, hist = [];
    for (let k = 0; k < HM; k++) { const base = s - 14 * (HM - 1 - k) / (HM - 1 || 1); const wig = ((j * 7 + k * 5) % 7) - 3; hist.push(Math.max(0, Math.min(100, Math.round(base + wig)))); }
    if (HM) hist[HM - 1] = s;
    sm.history = hist;
  });
}

const outPath = resolve(REPO, "data/timeline.cfp.json");
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
const avg = Math.round(Object.values(scores).reduce((s, v) => s + v, 0) / (Object.keys(scores).length || 1));
console.log(`✓ wrote ${outPath}`);
console.log(`  ${Object.keys(scores).length} axes · avg ${avg} · ${changes.length} real changes · ${Object.values(submetrics).reduce((n, a) => n + a.length, 0)} submetrics`);
