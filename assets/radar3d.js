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

export function mountRadar3D(root, timeline) {
  const axes = timeline.axes || [];
  const meas = (timeline.measurements || []).slice();
  const N = axes.length, M = meas.length;
  let selected = Math.max(0, M - 1);
  const TAU = Math.PI * 2;

  root.classList.add("vp");
  root.innerHTML = `
    <div class="vp-bar">
      <div class="vp-title">${esc(timeline.title || "Visibility over time")}</div>
      <button class="vp-btn" data-act="head" type="button">Face-on detail</button>
      <button class="vp-btn" data-act="orbit" type="button">3D time series</button>
      <div class="vp-hint"></div>
    </div>
    <div class="vp-stage">
      <div class="vp-scene"><div class="vp-overlay" aria-hidden="true"></div></div>
      <aside class="vp-side"></aside>
    </div>
    <div class="vp-chips"></div>`;
  const sceneEl = root.querySelector(".vp-scene");
  const overlay = root.querySelector(".vp-overlay");
  const sideEl = root.querySelector(".vp-side");
  const chipsEl = root.querySelector(".vp-chips");
  const hintEl = root.querySelector(".vp-hint");
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
      chips3d[i].innerHTML =
        `<div class="vp-axhead"><strong>${esc(axes[i].label)}</strong>` +
        `<span class="vp-score" style="color:${col};background:${col}1f">${s}</span>` +
        `<button class="vp-eye" type="button" data-i="${i}" aria-label="${esc(axes[i].label)} detail" aria-expanded="false">` +
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
    const b = e.target.closest(".vp-eye");
    if (b) { const i = +b.dataset.i; if (tipPinned && tipAxis === i) closeTip(); else { tipPinned = true; showTip(i); } }
    else if (tipPinned) closeTip();
  });

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

  // engine hooks (assigned by whichever renderer initializes)
  let onSelect = () => {};
  function select(i) { selected = clamp(i, 0, M - 1); renderSide(); renderChips(); paintOverlayChips(); onSelect(); }
  chipsEl.addEventListener("click", e => { const b = e.target.closest(".vp-chip"); if (b) select(+b.dataset.i); });

  if (webglAvailable()) initWebGL(); else initCanvas();
  renderSide(); renderChips(); paintOverlayChips(); onSelect();

  // =====================================================================
  // WebGL engine (high-quality 3D tube)
  // =====================================================================
  function initWebGL() {
    hintEl.textContent = "drag to orbit · scroll to zoom · face-on shows full detail";
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.className = "vp-canvas";
    sceneEl.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xf8faf8, 9, 24);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 8.6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false; controls.enablePan = false;
    controls.minDistance = 4.5; controls.maxDistance = 16; controls.target.set(0, 0, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 0.78));
    const k = new THREE.DirectionalLight(0xffffff, 0.55); k.position.set(4, 6, 8); scene.add(k);
    const rimL = new THREE.DirectionalLight(0xbfe3d4, 0.25); rimL.position.set(-5, -3, -6); scene.add(rimL);

    const R = 2.2, DZ = 1.15, ZAXIS = new THREE.Vector3(0, 0, 1);
    const vert = (i, t) => {
      const s = clamp(num(meas[t].scores[axes[i].key]), 0, 100), r = (s / 100) * R, a = -Math.PI / 2 + TAU * i / N;
      return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, (t - (M - 1) / 2) * DZ);
    };
    const group = new THREE.Group(); scene.add(group);
    for (let t = 0; t < M - 1; t++) {
      const pos = [];
      for (let i = 0; i < N; i++) {
        const i2 = (i + 1) % N, a = vert(i, t), b = vert(i2, t), c = vert(i2, t + 1), d = vert(i, t + 1);
        pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
      group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: HEX.teal, transparent: true, opacity: 0.16 + 0.12 * (t / Math.max(1, M - 2)), side: THREE.DoubleSide, roughness: 0.65, depthWrite: false })));
    }
    const nodeGeo = new THREE.SphereGeometry(0.055, 16, 12);
    const rings = [];
    for (let t = 0; t < M; t++) {
      const pts = []; for (let i = 0; i <= N; i++) pts.push(vert(i % N, t));
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: bandHex(avgScore(t)), transparent: true, opacity: 0.7 }));
      ring.userData.t = t; rings.push(ring); group.add(ring);
      for (let i = 0; i < N; i++) { const mm = new THREE.Mesh(nodeGeo, new THREE.MeshStandardMaterial({ color: bandHex(clamp(num(meas[t].scores[axes[i].key]), 0, 100)), roughness: 0.5 })); mm.position.copy(vert(i, t)); group.add(mm); }
    }
    const anchor = (i, t) => { const a = -Math.PI / 2 + TAU * i / N; return new THREE.Vector3(Math.cos(a) * R * 1.16, Math.sin(a) * R * 1.16, (t - (M - 1) / 2) * DZ); };

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
    onSelect = () => rings.forEach(r => { r.material.opacity = r.userData.t === selected ? 1 : 0.7; });

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
    const canvas = document.createElement("canvas"); canvas.className = "vp-canvas"; sceneEl.appendChild(canvas);
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
      [20, 40, 60, 80, 100].forEach(lv => { ctx.beginPath(); for (let i = 0; i <= N; i++) { const a = -Math.PI / 2 + TAU * (i % N) / N, rr = Rpx * lv / 100, x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr; i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.closePath(); ctx.strokeStyle = lv === 100 ? "#b8c7bc" : "#e2e8e2"; ctx.stroke(); });
      for (let i = 0; i < N; i++) { const a = -Math.PI / 2 + TAU * i / N; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * Rpx, cy + Math.sin(a) * Rpx); ctx.strokeStyle = "#e2e8e2"; ctx.stroke(); }
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
