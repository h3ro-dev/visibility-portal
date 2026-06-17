/*
 * visibility-portal — time-series radar.
 *
 * One artifact, two readings of the same data:
 *   - Face-on (looking down the time axis): the full per-axis detail overlay
 *     (CFP-portal-style axis chips) ringing the selected slice.
 *   - Orbited: a 3D tube of every measurement stacked along depth = time.
 *
 * Engine-pluggable + graceful: uses WebGL (Three.js) when available for the high-
 * quality 3D tube; falls back to a dependency-free canvas face-on radar when WebGL
 * is unavailable (older/headless browsers) so it never shows a blank/error.
 *
 *   mountRadar3D(rootEl, timeline)
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const BAND = { good: 75, watch: 60 };
const HEX = { teal: 0x275f55, good: 0x2e6f40, watch: 0xb87514, risk: 0x9b2424 };
function bandHex(s) { return s >= BAND.good ? HEX.good : s >= BAND.watch ? HEX.watch : HEX.risk; }
function bandCss(s) { return s >= BAND.good ? "#2e6f40" : s >= BAND.watch ? "#8a4b00" : "#9b2424"; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function webglAvailable() {
  try {
    if (!window.WebGLRenderingContext) return false;
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl"));
  } catch (_) { return false; }
}

// Cluster grouping (IA chunking): the 12 axes chunk into 3 groups of 4. Axes are
// reordered so each cluster is a contiguous arc. Cluster is a SEPARATE channel from
// health — a named label (primary, not colour-dependent) + a faint desaturated tint.
// Palette is cool/muted and deliberately clear of the green/amber/red health scale.
const DEFAULT_CLUSTERS = [
  { key: "foundation", label: "Foundation", color: "#44598a", axes: ["access", "crawl", "ia", "perf"] },
  { key: "credibility", label: "Credibility", color: "#7a566f", axes: ["proof", "authority", "trust", "local"] },
  { key: "demand", label: "Demand & Conversion", color: "#2f7d86", axes: ["demand", "aigeo", "cro", "attribution"] },
];
function clusterOrder(rawAxes, clusters) {
  const byKey = {}; rawAxes.forEach(a => { byKey[a.key] = a; });
  const out = [], seen = {};
  clusters.forEach(c => c.axes.forEach(k => { if (byKey[k]) { out.push(Object.assign({}, byKey[k], { cluster: c })); seen[k] = 1; } }));
  rawAxes.forEach(a => { if (!seen[a.key]) out.push(Object.assign({}, a, { cluster: null })); });   // unknown axes keep order, ungrouped
  return out;
}
function clusterSpans(axes) {   // contiguous index ranges per cluster, for sectors/labels
  const spans = []; let cur = null;
  axes.forEach((a, i) => {
    if (!a.cluster) { cur = null; return; }
    if (cur && cur.cluster === a.cluster) cur.end = i;
    else { cur = { cluster: a.cluster, start: i, end: i }; spans.push(cur); }
  });
  return spans;
}

export function mountRadar3D(root, timeline) {
  const axes = clusterOrder(timeline.axes || [], timeline.clusters || DEFAULT_CLUSTERS);
  const meas = (timeline.measurements || []).slice();
  const N = axes.length, M = meas.length;
  const spans = clusterSpans(axes);
  let selected = Math.max(0, M - 1);
  const TAU = Math.PI * 2;

  root.classList.add("vp");
  root.innerHTML = `
    <div class="vp-bar">
      <div class="vp-title">${esc(timeline.title || "Visibility over time")}</div>
      <span class="vp-runbadge" hidden></span>
      <button class="vp-btn" data-act="head" type="button">Face-on detail</button>
      <button class="vp-btn" data-act="orbit" type="button">3D time series</button>
      <div class="vp-hint"></div>
    </div>
    <div class="vp-stage">
      <div class="vp-scene"><div class="vp-overlay"></div></div>
      <aside class="vp-side"></aside>
    </div>
    <div class="vp-rank" aria-label="Axes ranked by score"></div>
    <div class="vp-chips"></div>`;
  const sceneEl = root.querySelector(".vp-scene");
  const overlay = root.querySelector(".vp-overlay");
  const sideEl = root.querySelector(".vp-side");
  const chipsEl = root.querySelector(".vp-chips");
  const hintEl = root.querySelector(".vp-hint");
  const rankEl = root.querySelector(".vp-rank");
  const runBadge = root.querySelector(".vp-runbadge");
  const btnHead = root.querySelector('[data-act="head"]');
  const btnOrbit = root.querySelector('[data-act="orbit"]');

  function avgScore(t) { let s = 0; for (let i = 0; i < N; i++) s += clamp(num(meas[t].scores[axes[i].key]), 0, 100); return Math.round(s / (N || 1)); }

  // ---- head-on detail overlay: per-axis chips + eye-tooltip (shared across engines) ----
  // Parity with the CFP scorecard: each axis chip carries a banded progress bar,
  // and an "eye" opens a brief (band + delta + a trajectory sparkline + the
  // changes targeting that axis = the gaps/proof line). All derived from the
  // timeline data — no extra contract fields needed.
  const chips3d = [];
  for (let i = 0; i < N; i++) {
    const c = document.createElement("div");
    c.className = "vp-axis"; c.dataset.i = i;
    overlay.appendChild(c); chips3d.push(c);
  }
  const tip = document.createElement("div");
  tip.className = "vp-tip"; tip.hidden = true; overlay.appendChild(tip);
  let tipAxis = -1, tipPinned = false;

  function bandLabel(s) { return s >= BAND.good ? "Strong" : s >= BAND.watch ? "Watch" : "Risk"; }
  function bandKey(s) { return s >= BAND.good ? "good" : s >= BAND.watch ? "watch" : "risk"; }

  function paintOverlayChips() {
    const t = selected;
    for (let i = 0; i < N; i++) {
      const s = clamp(num(meas[t].scores[axes[i].key]), 0, 100), col = bandCss(s);
      const det = (meas[t].detail || {})[axes[i].key];
      const weak = det && det.band ? (det.band === "blocked" || det.band === "constrained") : s < BAND.watch;
      chips3d[i].classList.toggle("weak", weak);   // Von Restorff: let the axes that need attention pop
      chips3d[i].innerHTML =
        `<div class="vp-axhead"><span class="vp-axcl" style="background:${axes[i].cluster ? axes[i].cluster.color : "transparent"}" title="${axes[i].cluster ? esc(axes[i].cluster.label) : ""}"></span><strong>${esc(axes[i].label)}</strong>` +
        `<span class="vp-score" style="color:${col};background:${col}1f">${s}</span>` +
        `<button class="vp-eye" type="button" data-i="${i}" aria-label="${esc(axes[i].label)} detail" aria-haspopup="dialog">` +
        `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>` +
        `</button></div>` +
        `<div class="vp-axisbar"><span style="width:${s}%;background:${col}"></span></div>`;
    }
    if (tipAxis >= 0) renderTip(tipAxis);   // keep an open brief in sync with the selected scan
  }

  // A 0–100 trajectory sparkline of one axis across every scan (the time-series
  // read of the CFP axis-drilldown's "submetric position"); selected scan marked.
  function axisSpark(i) {
    const key = axes[i].key, w = 132, h = 30, pad = 3;
    const pts = meas.map((m, t) => {
      const v = clamp(num(m.scores[key]), 0, 100);
      const x = pad + (w - 2 * pad) * (M <= 1 ? 0.5 : t / (M - 1));
      const y = (h - pad) - (h - 2 * pad) * (v / 100);
      return [x, y];
    });
    const d = pts.map((p, t) => (t ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const sel = pts[selected] || pts[pts.length - 1];
    const col = bandCss(clamp(num(meas[selected].scores[key]), 0, 100));
    return `<svg class="vp-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">` +
      `<path d="${d}" fill="none" stroke="#b3c2ba" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${sel[0].toFixed(1)}" cy="${sel[1].toFixed(1)}" r="3.1" fill="${col}"/></svg>`;
  }

  function renderTip(i) {
    const key = axes[i].key, m = meas[selected], prev = selected > 0 ? meas[selected - 1] : null;
    const s = clamp(num(m.scores[key]), 0, 100);
    const d = prev ? s - clamp(num(prev.scores[key]), 0, 100) : 0;
    const rel = (m.changes || []).filter(c => (c.targets || []).includes(key));
    let h = `<div class="vp-tip-head"><strong>${esc(axes[i].label)}</strong>` +
      `<span class="vp-pill ${bandKey(s)}">${bandLabel(s)}</span>` +
      `<span class="vp-tip-score" style="color:${bandCss(s)}">${s}</span></div>`;
    h += `<div class="vp-tip-sub">` + (prev
      ? `<b class="${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" + d : d}</b> vs ${esc(prev.timestamp)}`
      : `Baseline scan`) + `</div>`;
    h += `<div class="vp-tip-spark">${axisSpark(i)}<span>trajectory · ${M} scans</span></div>`;
    h += `<div class="vp-tip-sec">What's driving it</div>`;
    h += rel.length
      ? `<ul class="vp-tip-proof">${rel.map(c => {
          const ok = c.status === "confirmed";
          return `<li class="${ok ? "ok" : "sug"}"><span class="vp-st ${ok ? "ok" : "sug"}">${ok ? "confirmed" : "suggested"}</span>` +
            `<div>${esc(c.what || "")}</div>${c.source ? `<div class="vp-src">${esc(c.source)}</div>` : ""}</li>`;
        }).join("")}</ul>`
      : `<div class="vp-tip-gap">No recorded driver this period — open lane.</div>`;
    tip.innerHTML = h;
    positionTip(i);
  }

  function positionTip(i) {
    tip.hidden = false;                          // must be laid out to measure
    const cr = chips3d[i].getBoundingClientRect(), or = overlay.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const cxRel = cr.left + cr.width / 2 - or.left, cyRel = cr.top + cr.height / 2 - or.top;
    let left = cxRel < or.width / 2 ? cxRel + cr.width / 2 + 10 : cxRel - cr.width / 2 - 10 - tw;
    let top = cyRel - th / 2;
    left = clamp(left, 6, Math.max(6, or.width - tw - 6));
    top = clamp(top, 6, Math.max(6, or.height - th - 6));
    tip.style.transform = `translate(${left.toFixed(1)}px,${top.toFixed(1)}px)`;
  }

  function showTip(i) { tipAxis = i; renderTip(i); }
  function hideTip() { if (tipPinned) return; tipAxis = -1; tip.hidden = true; }
  function closeTip() { tipPinned = false; tipAxis = -1; tip.hidden = true; }   // force (used when orbiting)

  overlay.addEventListener("pointerover", e => { const c = e.target.closest(".vp-axis"); if (c) showTip(+c.dataset.i); });
  overlay.addEventListener("pointerout", e => { const c = e.target.closest(".vp-axis"); if (c && !c.contains(e.relatedTarget)) hideTip(); });
  overlay.addEventListener("focusin", e => { const b = e.target.closest(".vp-eye"); if (b) { tipPinned = false; showTip(+b.dataset.i); } });
  overlay.addEventListener("focusout", e => { if (e.target.closest(".vp-eye")) hideTip(); });
  overlay.addEventListener("click", e => {
    const eye = e.target.closest(".vp-eye");
    if (eye) { openDrill(+eye.dataset.i); return; }
    const chip = e.target.closest(".vp-axis");                 // clicking the whole domain opens its drill
    if (chip) { openDrill(+chip.dataset.i); return; }
    if (tipPinned) closeTip();
  });

  // ---- drill-down: per-axis sub-spider (real submetrics + provenance) ----
  // Detail-on-demand over the overview: the eye opens a focused sub-radar of the
  // axis's submetrics (radius = score; node size ∝ weight, so the submetrics that
  // actually drive the axis score dominate the eye), plus "where this comes from"
  // (the evidence systems), the highest-lift submetric, the day-one action, and the
  // honest confidence caveat. Falls back to the hover brief when an axis has no
  // submetric data (e.g. the synthetic demo rings).
  const subm = timeline.submetrics || {};
  const drill = document.createElement("div");
  drill.className = "vp-drill"; drill.hidden = true;
  drill.setAttribute("role", "dialog"); drill.setAttribute("aria-modal", "true");
  drill.setAttribute("aria-label", "Submetric detail");
  root.appendChild(drill);
  let lastFocus = null;

  function subRadarSVG(list, hi) {
    const cx = 170, cy = 158, R = 116, n = list.length, A = i => -Math.PI / 2 + TAU * i / n;
    const ring = lv => { let d = ""; for (let i = 0; i <= n; i++) { const a = A(i % n), rr = R * lv / 100; d += (i ? "L" : "M") + (cx + Math.cos(a) * rr).toFixed(1) + " " + (cy + Math.sin(a) * rr).toFixed(1) + " "; } return `<path d="${d}Z" fill="none" stroke="${lv === 100 ? "#c4d2c8" : "#e6ece6"}" stroke-width="1"/>`; };
    let svg = [25, 50, 75, 100].map(ring).join("");
    for (let i = 0; i < n; i++) { const a = A(i); svg += `<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(a) * R).toFixed(1)}" y2="${(cy + Math.sin(a) * R).toFixed(1)}" stroke="#e6ece6" stroke-width="1"/>`; }
    let poly = ""; for (let i = 0; i < n; i++) { const a = A(i), rr = R * clamp(num(list[i].score), 0, 100) / 100; poly += (i ? "L" : "M") + (cx + Math.cos(a) * rr).toFixed(1) + " " + (cy + Math.sin(a) * rr).toFixed(1) + " "; }
    svg += `<path d="${poly}Z" fill="rgba(39,95,85,.14)" stroke="#275f55" stroke-width="2" stroke-linejoin="round"/>`;
    for (let i = 0; i < n; i++) {
      const a = A(i), s = clamp(num(list[i].score), 0, 100), rr = R * s / 100, x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      const wr = 3 + 4 * (clamp(num(list[i].weight), 0, 20) / 20), on = i === hi;
      if (on) svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(wr + 4).toFixed(1)}" fill="none" stroke="${bandCss(s)}" stroke-width="2"/>`;
      svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(on ? wr + 1.5 : wr).toFixed(1)}" fill="${bandCss(s)}" stroke="#fff" stroke-width="1.5"/>`;
      const lx = cx + Math.cos(a) * (R + 13), ly = cy + Math.sin(a) * (R + 13);
      svg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" font-size="11" font-weight="${on ? 900 : 800}" fill="${on ? bandCss(s) : "#46524b"}" text-anchor="middle" dominant-baseline="central">${i + 1}</text>`;
    }
    return `<svg class="vp-subradar" viewBox="0 0 340 312" role="img" aria-label="${list.length} submetrics, radius = score, node size = weight">${svg}</svg>`;
  }

  // "Mountain range" time-series: an axis (or submetric) score across every scan.
  function mountainSVG(values, labels, selIdx, color) {
    const W = 520, H = 134, pL = 10, pR = 10, pT = 12, pB = 22, n = values.length, plotH = H - pT - pB;
    const X = k => n <= 1 ? W / 2 : pL + (W - pL - pR) * (k / (n - 1));
    const Y = v => pT + plotH * (1 - clamp(num(v), 0, 100) / 100);
    const pts = values.map((v, k) => [X(k), Y(v)]);
    let g = `<svg class="vp-mtn" viewBox="0 0 ${W} ${H}" role="img" aria-label="score over ${n} scans">`;
    [25, 50, 75].forEach(lv => { const y = Y(lv); g += `<line x1="${pL}" y1="${y.toFixed(1)}" x2="${W - pR}" y2="${y.toFixed(1)}" stroke="#eef2ee" stroke-width="1"/>`; });
    if (n > 1) {
      const base = H - pB;
      g += `<path d="M${pts[0][0].toFixed(1)} ${base} L` + pts.map(p => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L") + ` L${pts[n - 1][0].toFixed(1)} ${base} Z" fill="${color}" fill-opacity="0.13"/>`;
      g += `<path d="${pts.map((p, k) => (k ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ")}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    pts.forEach((p, k) => { const sel = k === selIdx; g += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${sel ? 4.5 : 2.6}" fill="${sel ? color : "#fff"}" stroke="${color}" stroke-width="${sel ? 2 : 1.6}"/>`; });
    const show = [...new Set([0, n - 1, selIdx >= 0 && selIdx < n ? selIdx : n - 1])];
    g += `<g font-size="9" fill="#7a847d">`;
    show.forEach(k => { if (k < 0 || k >= n) return; const anchor = k === 0 ? "start" : k === n - 1 ? "end" : "middle"; g += `<text x="${X(k).toFixed(1)}" y="${H - 7}" text-anchor="${anchor}">${esc(labels[k] || "")}</text>`; });
    return g + `</g></svg>`;
  }
  function explainerText(values, labels) {
    const n = values.length;
    if (n <= 1) return `Single scan so far — the trend fills in as runs accumulate.`;
    const first = clamp(num(values[0]), 0, 100), last = clamp(num(values[n - 1]), 0, 100), d = last - first;
    let bi = 1, bd = 0; for (let k = 1; k < n; k++) { const step = clamp(num(values[k]), 0, 100) - clamp(num(values[k - 1]), 0, 100); if (Math.abs(step) > Math.abs(bd)) { bd = step; bi = k; } }
    return `<b style="color:${bandCss(last)}">${last}</b> now · <b class="${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" + d : d}</b> since ${esc(labels[0] || "start")}` + (bd ? ` · biggest move <b class="${bd > 0 ? "up" : "down"}">${bd > 0 ? "+" + bd : bd}</b> (${esc(labels[bi - 1] || "")}→${esc(labels[bi] || "")})` : "");
  }

  let drillState = null;   // { i, list, sub }  — sub = submetric index or -1 (whole axis)
  function renderDrillTime() {
    if (!drillState) return;
    const { i, list, sub } = drillState, labels = meas.map(mm => mm.timestamp);
    let values, color, name;
    if (sub >= 0) { const sm = list[sub]; values = (sm.history && sm.history.length) ? sm.history : [clamp(num(sm.score), 0, 100)]; color = bandCss(clamp(num(sm.score), 0, 100)); name = sm.label; }
    else { const key = axes[i].key; values = meas.map(mm => clamp(num(mm.scores[key]), 0, 100)); color = bandCss(clamp(num(meas[selected].scores[key]), 0, 100)); name = "Whole axis"; }
    const useLabels = values.length === labels.length ? labels : labels.slice(-values.length);
    const tEl = drill.querySelector(".vp-drill-time");
    if (tEl) tEl.innerHTML = `<div class="vp-drill-lbl">Over time · ${esc(name)}${sub >= 0 ? ` <button class="vp-time-back" type="button">← whole axis</button>` : ""}</div>` +
      mountainSVG(values, useLabels, selected, color) + `<div class="vp-time-exp">${explainerText(values, useLabels)}</div>`;
    const lEl = drill.querySelector(".vp-drill-left"); if (lEl) lEl.innerHTML = subRadarSVG(list, sub);
    drill.querySelectorAll(".vp-li").forEach((b, idx) => b.classList.toggle("active", idx === sub));
  }
  function showSeries(sub) { if (drillState) { drillState.sub = sub; renderDrillTime(); } }

  function openDrill(i) {
    const key = axes[i].key, list = (subm[key] || []).slice();
    if (!list.length) { tipPinned = true; showTip(i); return; }   // no drill data → quick brief
    const m = meas[selected], s = clamp(num(m.scores[key]), 0, 100), det = (m.detail || {})[key] || {};
    lastFocus = document.activeElement;
    const sys = new Set(); list.forEach(x => (x.evidenceSystems || []).forEach(v => sys.add(v)));
    const titleCase = s => String(s || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const hl = det.highestLift, hlItem = list.find(x => x.key === hl), hlLabel = hlItem ? hlItem.label : titleCase(hl);
    let h = `<div class="vp-drill-card" role="document">` +
      `<button class="vp-drill-x" type="button" aria-label="Close detail">×</button>` +
      `<div class="vp-drill-head"><div class="vp-drill-id"><div class="vp-drill-ax">${esc(axes[i].label)}</div>` +
      `<div class="vp-drill-meta">${axes[i].cluster ? `<span class="vp-drill-cl" style="--cl:${axes[i].cluster.color}">${esc(axes[i].cluster.label)}</span> ` : ""}${list.length} submetrics${det.sourceWindow ? " · " + esc(det.sourceWindow) : ""}</div></div>` +
      `<span class="vp-drill-score" style="color:${bandCss(s)}">${s}<span>/100</span></span>` +
      `<span class="vp-pill ${bandKey(s)}">${bandLabel(s)}</span>` +
      (det.confidence ? `<span class="vp-conf">${esc(det.confidence.replace(/_/g, " "))}</span>` : "") +
      `</div>` +
      // spider next to the time-series mountain range (filled by renderDrillTime)
      `<div class="vp-drill-body"><div class="vp-drill-left">${subRadarSVG(list, -1)}</div><div class="vp-drill-right vp-drill-time"></div></div>`;
    let info = "";
    if (hl) info += `<div class="vp-drill-hl"><span class="vp-hl-tag">Highest lift</span><b>${esc(hlLabel)}</b></div>`;
    if (det.dayOneTactic) info += `<div class="vp-drill-act"><div class="vp-drill-lbl">Day-one action</div><p>${esc(det.dayOneTactic)}</p></div>`;
    if (sys.size) info += `<div class="vp-drill-prov"><div class="vp-drill-lbl">Where this comes from</div><div class="vp-prov-chips">${[...sys].slice(0, 14).map(v => `<span>${esc(v)}</span>`).join("")}</div></div>`;
    if (info) h += `<div class="vp-drill-info">${info}</div>`;
    h += `<div class="vp-drill-lbl vp-list-lbl">Submetrics — click one for its own trend</div><div class="vp-drill-list">${list.map((x, idx) => {
      const ss = clamp(num(x.score), 0, 100);
      return `<button class="vp-li" type="button" data-sub="${idx}"><span class="vp-li-n" style="background:${bandCss(ss)}">${idx + 1}</span>` +
        `<div class="vp-li-main"><div class="vp-li-top"><b>${esc(x.label)}</b><span class="vp-li-score" style="color:${bandCss(ss)}">${ss}</span></div>` +
        `<div class="vp-li-bar"><span style="width:${ss}%;background:${bandCss(ss)}"></span></div>` +
        ((x.sourceExamples || []).length ? `<div class="vp-li-src">${esc(x.sourceExamples.join(" · "))}</div>` : "") +
        `</div><span class="vp-li-w" title="weight in the axis score">${esc(x.weight)}%</span></button>`;
    }).join("")}</div>`;
    if (det.whatCannotProve) h += `<div class="vp-drill-caveat"><b>Can't yet prove —</b> ${esc(det.whatCannotProve)}</div>`;
    h += `</div>`;
    drill.innerHTML = h;
    drillState = { i, list, sub: -1 };
    renderDrillTime();
    drill.hidden = false;
    const xb = drill.querySelector(".vp-drill-x"); if (xb) xb.focus();
  }
  function closeDrill() { if (drill.hidden) return; drill.hidden = true; drillState = null; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  drill.addEventListener("click", e => {
    if (e.target === drill || e.target.closest(".vp-drill-x")) { closeDrill(); return; }
    if (e.target.closest(".vp-time-back")) { showSeries(-1); return; }
    const row = e.target.closest(".vp-li"); if (row) { showSeries(+row.dataset.sub); }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !drill.hidden) closeDrill(); });

  // ---- side causal panel + timestamp chips (shared) ----
  function deltaChip(d) { return d ? ` <span class="vp-d ${d > 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${d}</span>` : ""; }
  function renderSide() {
    const t = selected, m = meas[t], prev = t > 0 ? meas[t - 1] : null;
    let h = `<div class="vp-when"><b>${esc(m.timestamp)}</b>${m.label ? " · " + esc(m.label) : ""}</div>`;
    h += `<div class="vp-avg">Average <strong>${avgScore(t)}</strong>/100${prev ? deltaChip(avgScore(t) - avgScore(t - 1)) : ""}</div>`;
    if (prev) {
      const ds = axes.map(a => ({ label: a.label, d: num(m.scores[a.key]) - num(prev.scores[a.key]) })).filter(x => x.d !== 0).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      h += `<div class="vp-sec">Movement vs ${esc(prev.timestamp)}</div>`;
      h += ds.length ? `<ul class="vp-deltas">${ds.slice(0, 6).map(x => `<li><span>${esc(x.label)}</span><b class="${x.d > 0 ? "up" : "down"}">${x.d > 0 ? "+" : ""}${x.d}</b></li>`).join("")}</ul>` : `<div class="vp-empty">No score change.</div>`;
    } else { h += `<div class="vp-sec">Baseline</div><div class="vp-empty">First measurement.</div>`; }
    const ch = m.changes || [];
    h += `<div class="vp-sec">What changed</div>`;
    h += ch.length ? `<ul class="vp-changes">${ch.map(c => {
      const tg = (c.targets || []).map(k => (axes.find(a => a.key === k) || {}).label || k);
      return `<li><span class="vp-st ${c.status === "confirmed" ? "ok" : "sug"}">${c.status === "confirmed" ? "confirmed" : "suggested"}</span><div class="vp-what">${esc(c.what || "")}</div>${tg.length ? `<div class="vp-tg">→ ${esc(tg.join(", "))}</div>` : ""}${c.source ? `<div class="vp-src">${esc(c.source)}</div>` : ""}</li>`;
    }).join("")}</ul>` : `<div class="vp-empty">No changes recorded.</div>`;
    sideEl.innerHTML = h;
  }
  function renderChips() { chipsEl.innerHTML = meas.map((m, i) => `<button class="vp-chip${i === selected ? " active" : ""}" data-i="${i}" type="button">${esc(m.timestamp)}</button>`).join(""); }

  // ---- ranked bar-rail: precise comparison the radar's angles/area can't give ----
  // Radar = gestalt (overall shape); a sorted bar list = the exact ranking. Weakest /
  // blocked axes are flagged (Von Restorff) since "where am I worst + what next" is the
  // job; a confidence dot per axis surfaces how trustworthy each score is. Clicking a
  // row opens that axis's drill-down — same affordance as the eye.
  function confClass(c) { c = String(c || ""); if (/partial/.test(c)) return "mid"; if (/block|unverified|missing|none|unknown/.test(c)) return "low"; if (/verified|fully|complete/.test(c)) return "ok"; return "mid"; }
  function clusterAvg(sp, t) { let s = 0, n = 0; for (let i = sp.start; i <= sp.end; i++) { s += clamp(num(meas[t].scores[axes[i].key]), 0, 100); n++; } return Math.round(s / (n || 1)); }
  function renderRank() {
    const m = meas[selected], det = m.detail || {};
    // cluster summary strip — the chunked, group-level read (3 averages)
    const strip = spans.length ? `<div class="vp-cluster-strip">` + spans.map(sp => {
      const av = clusterAvg(sp, selected);
      return `<div class="vp-cluster-card" style="--cl:${sp.cluster.color}">` +
        `<div class="vp-cluster-top"><span class="vp-cluster-name">${esc(sp.cluster.label)}</span><span class="vp-cluster-avg" style="color:${bandCss(av)}">${av}</span></div>` +
        `<div class="vp-cluster-bar"><span style="width:${av}%"></span></div>` +
        `<div class="vp-cluster-axes">${esc(axes.slice(sp.start, sp.end + 1).map(a => a.label).join(" · "))}</div>` +
        `</div>`;
    }).join("") + `</div>` : "";
    const rows = axes.map((a, i) => ({ i, label: a.label, key: a.key, cl: a.cluster, s: clamp(num(m.scores[a.key]), 0, 100), band: (det[a.key] || {}).band, conf: (det[a.key] || {}).confidence }))
      .sort((x, y) => y.s - x.s);
    rankEl.innerHTML = strip +
      `<div class="vp-rank-h"><span>Where you stand</span><span class="vp-rank-sub">${esc(m.timestamp)} · ranked by score${(m.detail ? " · dot = confidence" : "")}</span></div>` +
      `<div class="vp-rank-grid">` + rows.map((r, idx) => {
        const weak = r.band ? (r.band === "blocked" || r.band === "constrained") : r.s < BAND.watch;
        return `<button class="vp-rank-row${weak ? " weak" : ""}" data-i="${r.i}" type="button">` +
          `<span class="vp-rank-n">${idx + 1}</span>` +
          `<span class="vp-rank-cl" style="background:${r.cl ? r.cl.color : "transparent"}" title="${r.cl ? esc(r.cl.label) : ""}"></span>` +
          `<span class="vp-rank-lab">${esc(r.label)}</span>` +
          `<span class="vp-rank-bar"><span style="width:${r.s}%;background:${bandCss(r.s)}"></span></span>` +
          `<span class="vp-rank-sc" style="color:${bandCss(r.s)}">${r.s}</span>` +
          (r.conf ? `<span class="vp-rank-dot ${confClass(r.conf)}" title="${esc(r.conf.replace(/_/g, " "))}"></span>` : `<span class="vp-rank-dot none"></span>`) +
          `</button>`;
      }).join("") + `</div>`;
    if (runBadge) {
      if (m.real && m.confidence) { runBadge.hidden = false; runBadge.className = "vp-runbadge live"; runBadge.textContent = "● live · " + m.confidence.replace(/_/g, " "); }
      else if (m.synthetic) { runBadge.hidden = false; runBadge.className = "vp-runbadge demo"; runBadge.textContent = "demo history"; }
      else { runBadge.hidden = true; }
    }
  }
  rankEl.addEventListener("click", e => { const b = e.target.closest(".vp-rank-row"); if (b) openDrill(+b.dataset.i); });

  // engine hooks (assigned by whichever renderer initializes)
  let onSelect = () => {};
  function select(i) { selected = clamp(i, 0, M - 1); renderSide(); renderChips(); renderRank(); paintOverlayChips(); onSelect(); }
  chipsEl.addEventListener("click", e => { const b = e.target.closest(".vp-chip"); if (b) select(+b.dataset.i); });

  if (webglAvailable()) initWebGL(); else initCanvas();
  renderSide(); renderChips(); renderRank(); paintOverlayChips(); onSelect();

  // =====================================================================
  // WebGL engine (high-quality 3D tube)
  // =====================================================================
  function initWebGL() {
    hintEl.textContent = "drag to orbit · scroll to zoom · face-on shows full detail";
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = "vp-canvas";
    renderer.domElement.setAttribute("aria-hidden", "true");   // decorative; chips/rank are the accessible layer
    sceneEl.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xf8faf8, 9, 24);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 9.0);   // a touch further back: keeps face-on chips clear of the edges with DZ=1.3, and frames the labelled tube
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false; controls.enablePan = false;
    controls.minDistance = 5; controls.maxDistance = 20; controls.target.set(0, 0, 0);
    controls.rotateSpeed = 0.85; controls.zoomSpeed = 0.9;
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    scene.add(new THREE.HemisphereLight(0xffffff, 0xdce8e1, 0.45));               // sky/ground wrap
    const k = new THREE.DirectionalLight(0xffffff, 0.78); k.position.set(5, 8, 9); scene.add(k);
    const fill = new THREE.DirectionalLight(0xeef5f0, 0.28); fill.position.set(-7, -2, 5); scene.add(fill);
    const rimL = new THREE.DirectionalLight(0x8fccb8, 0.45); rimL.position.set(-5, 4, -8); scene.add(rimL);

    const R = 2.2, DZ = 1.3, ZAXIS = new THREE.Vector3(0, 0, 1);
    const zOf = t => (t - (M - 1) / 2) * DZ;
    const vert = (i, t) => {
      const s = clamp(num(meas[t].scores[axes[i].key]), 0, 100), r = (s / 100) * R, a = -Math.PI / 2 + TAU * i / N;
      return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, (t - (M - 1) / 2) * DZ);
    };
    const group = new THREE.Group(); scene.add(group);
    const tealC = new THREE.Color(HEX.teal);
    for (let t = 0; t < M - 1; t++) {
      const pos = [];
      for (let i = 0; i < N; i++) {
        const i2 = (i + 1) % N, a = vert(i, t), b = vert(i2, t), c = vert(i2, t + 1), d = vert(i, t + 1);
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
      const segC = tealC.clone().lerp(new THREE.Color(bandHex(avgScore(t + 1))), 0.3);   // tint toward that window's health
      group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: segC, emissive: segC, emissiveIntensity: 0.05, transparent: true,
        opacity: 0.12 + 0.20 * (t / Math.max(1, M - 2)), side: THREE.DoubleSide, roughness: 0.5, metalness: 0, depthWrite: false,
      })));
    }
    const nodeGeo = new THREE.SphereGeometry(0.052, 16, 12);
    const ringBase = t => 0.3 + 0.32 * (M > 1 ? t / (M - 1) : 1);   // older rings fainter, newest crisp
    const rings = [];
    for (let t = 0; t < M; t++) {
      const pts = []; for (let i = 0; i <= N; i++) pts.push(vert(i % N, t));
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: bandHex(avgScore(t)), transparent: true, opacity: ringBase(t) }));
      ring.userData.t = t; rings.push(ring); group.add(ring);
      for (let i = 0; i < N; i++) { const mm = new THREE.Mesh(nodeGeo, new THREE.MeshStandardMaterial({ color: bandHex(clamp(num(meas[t].scores[axes[i].key]), 0, 100)), roughness: 0.42 })); mm.position.copy(vert(i, t)); group.add(mm); }
    }
    const anchor = (i, t) => { const a = -Math.PI / 2 + TAU * i / N; return new THREE.Vector3(Math.cos(a) * R * 1.16, Math.sin(a) * R * 1.16, zOf(t)); };

    // ---- clean vectors from the centre out to each point of reference (selected slice) ----
    const vectorsObj = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x275f55, transparent: true, opacity: 0 }));
    vectorsObj.userData.base = 0.5; scene.add(vectorsObj);
    function rebuildVectors() {
      const z = zOf(selected), pos = [];
      for (let i = 0; i < N; i++) { const v = vert(i, selected); pos.push(0, 0, z, v.x, v.y, v.z); }
      vectorsObj.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      vectorsObj.geometry.attributes.position.needsUpdate = true;
    }
    rebuildVectors();

    // ---- on-tube labels: axis names (newest ring) + per-scan dates (time axis) ----
    // Sprites live in the 3D scene (depth-sorted, fog-lit) and crossfade IN as the
    // face-on chips fade OUT, so the orbit view is legible without crowding face-on.
    function makeLabel(text, opt) {
      opt = opt || {};
      const font = opt.font || 23, weight = opt.weight || 700, padX = 9, padY = 5, dpr = 2;
      const cv = document.createElement("canvas"), ctx = cv.getContext("2d");
      const fontStr = `${weight} ${font}px Inter, system-ui, sans-serif`;
      ctx.font = fontStr;
      const w = Math.ceil(ctx.measureText(text).width) + padX * 2, h = font + padY * 2, r = h / 2;
      cv.width = w * dpr; cv.height = h * dpr; ctx.scale(dpr, dpr);
      ctx.beginPath();
      ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r); ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r); ctx.closePath();
      ctx.fillStyle = opt.bg || "rgba(255,255,255,0.92)"; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = opt.border || "rgba(23,33,27,0.12)"; ctx.stroke();
      ctx.fillStyle = opt.color || "#27332b"; ctx.font = fontStr; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(text, w / 2, h / 2 + 0.5);
      const tex = new THREE.CanvasTexture(cv); tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 }));
      const unit = opt.world || 0.0042; sp.scale.set(w * unit, h * unit, 1);
      sp.renderOrder = 10; sp.userData.base = opt.base == null ? 1 : opt.base;
      return sp;
    }
    const labels = new THREE.Group(); scene.add(labels);
    const dateLabels = [];
    for (let i = 0; i < N; i++) {
      const a = -Math.PI / 2 + TAU * i / N;
      const sp = makeLabel(axes[i].label, { font: 22, world: 0.0040 });
      sp.position.set(Math.cos(a) * R * 1.34, Math.sin(a) * R * 1.34, zOf(M - 1));
      labels.add(sp);
    }
    for (let t = 0; t < M; t++) {
      const sp = makeLabel(meas[t].timestamp, { font: 21, world: 0.0040, color: "#46524b", bg: "rgba(247,250,248,0.94)" });
      sp.position.set(0, -R * 1.32, zOf(t));
      sp.userData.base = t === selected ? 1 : 0.45;
      labels.add(sp); dateLabels.push(sp);
    }

    // Cluster cue on the WebGL face-on view lives on the DOM chips (a colour tick,
    // set in paintOverlayChips) + the named summary strip + the reordered contiguous
    // arcs — reliable and un-clipped, vs. in-scene pills that collide with the chips.

    // Eased camera fly between views. We interpolate in spherical space around
    // the orbit target (radius preserved = zoom kept; camera always looks at the
    // target so it can't blank) and DON'T call controls.update() mid-fly — that
    // fight is what blanked the scene before. When the fly ends we re-enable the
    // controls and sync them once to the final pose. Drag-orbit stays native.
    const VIEW = { head: { theta: 0, phi: Math.PI / 2 }, orbit: { theta: 0.95, phi: 1.2 } };
    const REDUCED = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const FLY_MS = REDUCED ? 0 : 700;
    const _tmpV = new THREE.Vector3(), _tmpS = new THREE.Spherical();
    const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const wrapPi = a => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
    const clampPhi = p => clamp(p, 1e-3, Math.PI - 1e-3);

    let headOn = true;            // logical destination — drives drag-time fade + chip interactivity
    let fly = null;               // active tween descriptor, or null
    overlay.style.opacity = "1";  // start face-on with the detail overlay shown

    function flyTo(view, faceOn) {
      const from = _tmpS.setFromVector3(_tmpV.copy(camera.position).sub(controls.target));
      headOn = faceOn;
      controls.enabled = false;   // controls must not fight the tween
      fly = {
        radius: from.radius,
        theta0: from.theta, dTheta: wrapPi(view.theta - from.theta),   // shortest angular path
        phi0: from.phi, phi1: clampPhi(view.phi),
        op0: parseFloat(overlay.style.opacity) || 0, op1: faceOn ? 1 : 0,
        t0: -1,
      };
    }
    btnHead.addEventListener("click", () => flyTo(VIEW.head, true));
    btnOrbit.addEventListener("click", () => { closeTip(); flyTo(VIEW.orbit, false); });
    controls.addEventListener("start", () => { headOn = false; closeTip(); });   // any drag = exploring the 3D tube
    onSelect = () => {
      rings.forEach(r => { r.material.opacity = r.userData.t === selected ? 1 : ringBase(r.userData.t); });
      dateLabels.forEach((sp, t) => { sp.userData.base = t === selected ? 1 : 0.45; });
      rebuildVectors();
    };

    // Click a vertex or its vector (face-on) to open that domain's drill — same as the chip/eye.
    function distToSeg(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = clamp(t, 0, 1); return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); }
    let _downXY = null;
    renderer.domElement.addEventListener("pointerdown", e => { _downXY = [e.clientX, e.clientY]; });
    renderer.domElement.addEventListener("click", e => {
      if (!headOn || fly) return;
      if ((parseFloat(overlay.style.opacity) || 0) < 0.5) return;                          // only face-on
      if (_downXY && (Math.abs(e.clientX - _downXY[0]) + Math.abs(e.clientY - _downXY[1])) > 6) return;   // was a drag
      const r = renderer.domElement.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const C = new THREE.Vector3(0, 0, zOf(selected)).project(camera), ccx = (C.x * .5 + .5) * r.width, ccy = (-C.y * .5 + .5) * r.height;
      let best = -1, bd = 20;
      for (let i = 0; i < N; i++) {
        const v = vert(i, selected).project(camera), vx = (v.x * .5 + .5) * r.width, vy = (-v.y * .5 + .5) * r.height;
        const d = Math.min(Math.hypot(vx - px, vy - py), distToSeg(px, py, ccx, ccy, vx, vy));
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) openDrill(best);
    });

    function resize() { const w = Math.max(280, sceneEl.clientWidth), h = Math.max(320, sceneEl.clientHeight); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    if (window.ResizeObserver) new ResizeObserver(resize).observe(sceneEl);
    resize();

    function positionChips(op) {
      overlay.classList.toggle("vp-int", op > 0.5 && !fly);   // chips interactive only while face-on
      if (op <= 0.001) return;    // fully orbited: skip projection, overlay is invisible anyway
      const w = sceneEl.clientWidth, h = sceneEl.clientHeight;
      for (let i = 0; i < N; i++) {
        const p2 = anchor(i, selected).project(camera);
        chips3d[i].style.transform = `translate(-50%,-50%) translate(${((p2.x * 0.5 + 0.5) * w).toFixed(1)}px,${((-p2.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
        chips3d[i].style.display = p2.z < 1 ? "" : "none";
      }
    }

    function frame(now) {
      let op;
      if (fly) {
        if (fly.t0 < 0) fly.t0 = now;
        let p = FLY_MS > 0 ? (now - fly.t0) / FLY_MS : 1;
        if (p >= 1) p = 1;
        const e = easeInOut(p);
        _tmpS.set(fly.radius, fly.phi0 + (fly.phi1 - fly.phi0) * e, fly.theta0 + fly.dTheta * e);
        camera.position.copy(controls.target).add(_tmpV.setFromSpherical(_tmpS));
        camera.lookAt(controls.target);
        op = fly.op0 + (fly.op1 - fly.op0) * e;
        overlay.style.opacity = op.toFixed(3);
        if (p === 1) { fly = null; controls.enabled = true; controls.update(); }   // hand the pose back to controls
      } else {
        controls.update();
        const tgt = headOn ? 1 : 0, cur = parseFloat(overlay.style.opacity) || 0;
        op = Math.abs(tgt - cur) < 4e-3 ? tgt : cur + (tgt - cur) * 0.18;          // smooth drag-time fade
        overlay.style.opacity = op.toFixed(3);
      }
      positionChips(op);
      const lop = 1 - op;                       // labels fade in as the face-on chips fade out
      labels.visible = lop > 0.02;
      if (labels.visible) for (const sp of labels.children) sp.material.opacity = sp.userData.base * lop;
      vectorsObj.visible = op > 0.02;           // centre→point vectors are a face-on concept
      if (vectorsObj.visible) vectorsObj.material.opacity = vectorsObj.userData.base * op;
      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // =====================================================================
  // Canvas fallback (face-on detail radar; no WebGL required)
  // =====================================================================
  function initCanvas() {
    hintEl.textContent = "face-on detail (3D orbit needs WebGL — unavailable here)";
    btnOrbit.disabled = true;
    overlay.style.opacity = "1";
    overlay.classList.add("vp-int");   // canvas mode is always face-on detail → chips interactive
    const canvas = document.createElement("canvas"); canvas.className = "vp-canvas"; canvas.setAttribute("aria-hidden", "true"); sceneEl.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, DPR = 1, cx = 0, cy = 0, Rpx = 0;

    function size() {
      const w = Math.max(280, sceneEl.clientWidth), h = Math.max(320, sceneEl.clientHeight);
      if (w === W && h === H && canvas.width) return;
      W = w; H = h; DPR = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      cx = W / 2; cy = H / 2; Rpx = Math.min(W, H) * 0.32;
    }
    function draw() {
      size(); ctx.clearRect(0, 0, W, H);
      const t = selected;
      spans.forEach(sp => {   // faint cluster sectors behind the grid (separate channel from health)
        const a0 = -Math.PI / 2 + TAU * (sp.start - 0.5) / N, a1 = -Math.PI / 2 + TAU * (sp.end + 0.5) / N;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, Rpx * 1.04, a0, a1); ctx.closePath();
        ctx.fillStyle = sp.cluster.color; ctx.globalAlpha = 0.07; ctx.fill(); ctx.globalAlpha = 1;
      });
      [20, 40, 60, 80, 100].forEach(lv => { ctx.beginPath(); for (let i = 0; i <= N; i++) { const a = -Math.PI / 2 + TAU * (i % N) / N, rr = Rpx * lv / 100, x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.closePath(); ctx.strokeStyle = lv === 100 ? "#b8c7bc" : "#e2e8e2"; ctx.stroke(); });
      for (let i = 0; i < N; i++) { const a = -Math.PI / 2 + TAU * i / N; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * Rpx, cy + Math.sin(a) * Rpx); ctx.strokeStyle = "#e2e8e2"; ctx.stroke(); }
      ctx.font = "800 12px Inter, system-ui, sans-serif"; ctx.textBaseline = "middle";   // cluster name labels at each arc midpoint
      spans.forEach(sp => {
        const mid = -Math.PI / 2 + TAU * (sp.start + sp.end) / 2 / N, lx = cx + Math.cos(mid) * Rpx * 1.36, ly = cy + Math.sin(mid) * Rpx * 1.36;
        ctx.fillStyle = sp.cluster.color; ctx.textAlign = Math.cos(mid) > 0.2 ? "left" : Math.cos(mid) < -0.2 ? "right" : "center";
        ctx.fillText(sp.cluster.label, lx, ly);
      });
      for (let i = 0; i < N; i++) { const a = -Math.PI / 2 + TAU * i / N, s = clamp(num(meas[t].scores[axes[i].key]), 0, 100), rr = Rpx * s / 100; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); ctx.strokeStyle = "rgba(39,95,85,0.35)"; ctx.lineWidth = 1.5; ctx.stroke(); }   // clean vectors: centre → point of reference
      ctx.beginPath(); for (let i = 0; i < N; i++) { const a = -Math.PI / 2 + TAU * i / N, s = clamp(num(meas[t].scores[axes[i].key]), 0, 100), rr = Rpx * s / 100, x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.closePath();
      ctx.fillStyle = "rgba(39,95,85,0.16)"; ctx.fill(); ctx.strokeStyle = "#275f55"; ctx.lineWidth = 2; ctx.stroke();
      for (let i = 0; i < N; i++) { const a = -Math.PI / 2 + TAU * i / N, s = clamp(num(meas[t].scores[axes[i].key]), 0, 100), rr = Rpx * s / 100, x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr; ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fillStyle = bandCss(s); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.fill(); ctx.stroke(); }
      ctx.fillStyle = "#17211b"; ctx.font = "700 13px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText(meas[t].timestamp, cx, cy - 4);
      ctx.fillStyle = "#64706a"; ctx.font = "11px system-ui, sans-serif"; ctx.fillText("avg " + avgScore(t), cx, cy + 12);
    }
    function positionChips() { for (let i = 0; i < N; i++) { const a = -Math.PI / 2 + TAU * i / N, x = cx + Math.cos(a) * Rpx * 1.16, y = cy + Math.sin(a) * Rpx * 1.16; chips3d[i].style.transform = `translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`; chips3d[i].style.display = ""; } }
    onSelect = () => { draw(); positionChips(); };
    if (window.ResizeObserver) new ResizeObserver(() => { draw(); positionChips(); }).observe(sceneEl);
    draw(); positionChips();
  }
}
