/*
 * scan-radar3d — dependency-free 3D time-series radar ("conic") + causal ledger.
 *
 * Each measurement is a flat N-axis radar slice. Slices are stacked along a
 * depth = time axis and joined spoke-to-spoke into one orbitable tube. Two modes:
 *   - "3d":   orbit the whole tube (drag = yaw/pitch, wheel = zoom).
 *   - "flat": one measurement's radar, face-on.
 * Click a slice -> flat for that timestamp. Click empty space / "3D" -> orbit.
 *
 * Usage:
 *   ScanRadar3D.mount(rootEl, { dataUrl: "timeline.json" });
 *   ScanRadar3D.mount(rootEl, { timeline: {...} });
 *
 * Data contract: see timeline.sample.json / SKILL.md.
 */
(function (global) {
  "use strict";

  var TAU = Math.PI * 2;
  var BANDS = { good: 75, watch: 60 }; // >=75 good, >=60 watch, else risk
  var COLORS = {
    ink: "#17211b", muted: "#64706a", line: "#d7dfd8",
    teal: "#275f55", good: "#2e6f40", watch: "#8a4b00", risk: "#9b2424",
    grid: "#e2e8e2", gridStrong: "#b8c7bc", paper: "#f8faf8"
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOutQuint(t) { return 1 - Math.pow(1 - t, 5); } // strong ease-out (Emil: built-in curves lack punch)
  function nowMs() { return (global.performance && performance.now) ? performance.now() : Date.now(); }
  function bandColor(score) {
    if (score >= BANDS.good) return COLORS.good;
    if (score >= BANDS.watch) return COLORS.watch;
    return COLORS.risk;
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function create(root, opts) {
    opts = opts || {};
    var timeline = opts.timeline || { axes: [], measurements: [] };
    var axes = timeline.axes || [];
    var measurements = (timeline.measurements || []).slice();
    var N = axes.length;
    var M = measurements.length;

    var reduceMotion = !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var DEFAULT_YAW = -0.62, DEFAULT_PITCH = -0.5;
    var st = {
      mode: M > 1 ? "3d" : "flat",
      selected: Math.max(0, M - 1),
      yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, zoom: 1,
      autospin: false, spinSpeed: 0,
      drag: null, moved: 0,
      vel: { yaw: 0, pitch: 0 },   // angular velocity for release inertia
      anim: null                    // active eased camera tween
    };

    // ---- DOM ----
    root.classList.add("sr3d");
    root.innerHTML = "";
    var bar = el("div", "sr3d-bar");
    var title = el("div", "sr3d-title", esc(timeline.title || "Visibility over time"));
    var badge = el("span", "sr3d-runbadge"); badge.hidden = true;
    var modes = el("div", "sr3d-modes");
    var btn3d = el("button", "sr3d-mode", "3D time series"); btn3d.dataset.mode = "3d"; btn3d.type = "button";
    var btnFlat = el("button", "sr3d-mode", "Flat slice"); btnFlat.dataset.mode = "flat"; btnFlat.type = "button";
    modes.appendChild(btn3d); modes.appendChild(btnFlat);
    var spin = el("button", "sr3d-spin", "Auto-spin"); spin.type = "button";
    var hint = el("div", "sr3d-hint", "drag to rotate · scroll to zoom · click a slice · click an axis for detail");
    bar.appendChild(title); bar.appendChild(badge); bar.appendChild(modes); bar.appendChild(spin); bar.appendChild(hint);

    var stage = el("div", "sr3d-stage");
    var canvasWrap = el("div", "sr3d-canvas-wrap");
    var canvas = el("canvas", "sr3d-canvas");
    canvasWrap.appendChild(canvas);
    var side = el("aside", "sr3d-side");
    stage.appendChild(canvasWrap); stage.appendChild(side);

    var chips = el("div", "sr3d-chips");
    var rank = el("div", "sr3d-rank"); rank.setAttribute("aria-label", "Axes ranked by score");
    var drill = el("div", "sr3d-drill"); drill.hidden = true;
    drill.setAttribute("role", "dialog"); drill.setAttribute("aria-modal", "true"); drill.setAttribute("aria-label", "Submetric detail");
    var subm = timeline.submetrics || {};
    var lastFocus = null;

    root.appendChild(bar); root.appendChild(stage); root.appendChild(rank); root.appendChild(chips); root.appendChild(drill);

    if (M < 2) { btn3d.disabled = true; spin.disabled = true; st.mode = "flat"; hint.textContent = "single measurement — 3D appears once there are 2+"; }
    if (reduceMotion) spin.disabled = true;

    // ---- canvas sizing ----
    var ctx = canvas.getContext("2d");
    var W = 0, H = 0, DPR = 1;
    function resize() {
      // Measure the content box (clientW/H excludes the border). The canvas is
      // absolutely positioned, so it never feeds its own height back into the
      // wrap — which previously caused unbounded growth (the page "fell down").
      var w = Math.max(280, canvasWrap.clientWidth || 280);
      var h = Math.max(320, canvasWrap.clientHeight || Math.round(w * 0.78));
      if (w === W && h === H && canvas.width) return; // no real change -> avoid ResizeObserver feedback loop
      W = w; H = h;
      DPR = Math.min(global.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(W * DPR);
      canvas.height = Math.floor(H * DPR);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      renderCanvas(); // canvas only — never rebuild the DOM panel here (it would feed back into ResizeObserver)
    }

    // ---- geometry ----
    function radius() { return Math.min(W, H) * 0.30; }
    function depthSpacing() {
      var span = Math.min(W, H) * 0.62;
      return M > 1 ? span / (M - 1) : 0;
    }
    function point3d(i, t) {
      var R = radius();
      var score = clamp(num(measurements[t].scores[axes[i].key]), 0, 100);
      var r = (score / 100) * R;
      var ang = -Math.PI / 2 + TAU * i / N;
      return { x: Math.cos(ang) * r, y: Math.sin(ang) * r, z: (t - (M - 1) / 2) * depthSpacing() };
    }
    function rotate(p) {
      var cy = Math.cos(st.yaw), sy = Math.sin(st.yaw);
      var x1 = p.x * cy + p.z * sy;
      var z1 = -p.x * sy + p.z * cy;
      var cx = Math.cos(st.pitch), sx = Math.sin(st.pitch);
      var y2 = p.y * cx - z1 * sx;
      var z2 = p.y * sx + z1 * cx;
      return { x: x1, y: y2, z: z2 };
    }
    function project(p) {
      var r = rotate(p);
      return { x: W / 2 + r.x * st.zoom, y: H / 2 + r.y * st.zoom, z: r.z };
    }

    // ---- render ----
    // renderCanvas() is cheap and runs every animation frame; renderPanel()
    // rebuilds DOM and runs only when the selection/mode/data changes (so the
    // staggered causal cards aren't restarted on every orbit frame).
    function renderCanvas() {
      ctx.clearRect(0, 0, W, H);
      if (!N || !M) { emptyMsg("No timeline data"); return; }
      if (st.mode === "flat") renderFlat(); else render3d();
      btn3d.classList.toggle("active", st.mode === "3d");
      btnFlat.classList.toggle("active", st.mode === "flat");
      spin.classList.toggle("active", st.autospin);
    }
    function renderPanel() { renderSide(); renderChips(); renderRank(); }
    function render() { renderCanvas(); renderPanel(); }

    function emptyMsg(msg) {
      ctx.fillStyle = COLORS.muted; ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.fillText(msg, W / 2, H / 2);
    }

    function render3d() {
      var faces = [];
      // tube walls between consecutive measurements
      for (var t = 0; t < M - 1; t++) {
        for (var i = 0; i < N; i++) {
          var i2 = (i + 1) % N;
          var a = project(point3d(i, t)), b = project(point3d(i2, t));
          var c = project(point3d(i2, t + 1)), d = project(point3d(i, t + 1));
          faces.push({ kind: "wall", pts: [a, b, c, d], z: (a.z + b.z + c.z + d.z) / 4, t: t });
        }
      }
      // slice rings
      for (var tt = 0; tt < M; tt++) {
        var ring = [], zsum = 0;
        for (var k = 0; k < N; k++) { var p = project(point3d(k, tt)); ring.push(p); zsum += p.z; }
        faces.push({ kind: "ring", pts: ring, z: zsum / N, t: tt });
      }
      faces.sort(function (f1, f2) { return f1.z - f2.z; }); // far -> near

      var zs = faces.map(function (f) { return f.z; });
      var zmin = Math.min.apply(null, zs), zmax = Math.max.apply(null, zs);
      var zrange = (zmax - zmin) || 1;

      faces.forEach(function (f) {
        var near = (f.z - zmin) / zrange; // 0 far .. 1 near
        if (f.kind === "wall") {
          ctx.beginPath();
          ctx.moveTo(f.pts[0].x, f.pts[0].y);
          for (var j = 1; j < f.pts.length; j++) ctx.lineTo(f.pts[j].x, f.pts[j].y);
          ctx.closePath();
          ctx.fillStyle = "rgba(39,95,85," + (0.05 + near * 0.20).toFixed(3) + ")";
          ctx.fill();
          ctx.strokeStyle = "rgba(39,95,85," + (0.12 + near * 0.22).toFixed(3) + ")";
          ctx.lineWidth = 1; ctx.stroke();
        } else {
          var avg = avgScore(f.t);
          var selected = f.t === st.selected;
          ctx.beginPath();
          ctx.moveTo(f.pts[0].x, f.pts[0].y);
          for (var m = 1; m < f.pts.length; m++) ctx.lineTo(f.pts[m].x, f.pts[m].y);
          ctx.closePath();
          ctx.strokeStyle = bandColor(avg);
          ctx.globalAlpha = selected ? 1 : 0.45 + near * 0.4;
          ctx.lineWidth = selected ? 3 : 1.5;
          ctx.stroke();
          if (selected) { ctx.fillStyle = "rgba(39,95,85,0.10)"; ctx.fill(); }
          ctx.globalAlpha = 1;
          // vertices
          f.pts.forEach(function (pt) {
            ctx.beginPath(); ctx.arc(pt.x, pt.y, selected ? 3.2 : 2, 0, TAU);
            ctx.fillStyle = bandColor(avg); ctx.globalAlpha = selected ? 1 : 0.5 + near * 0.4;
            ctx.fill(); ctx.globalAlpha = 1;
          });
          if (selected) labelRing(f.pts);
        }
      });
      // time direction caption
      ctx.fillStyle = COLORS.muted; ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "left"; ctx.fillText("depth = time  ·  front = latest", 12, H - 12);
    }

    function labelRing(pts) {
      ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = COLORS.ink;
      var cxp = 0, cyp = 0;
      pts.forEach(function (p) { cxp += p.x; cyp += p.y; });
      cxp /= pts.length; cyp /= pts.length;
      pts.forEach(function (p, i) {
        var dx = p.x - cxp, dy = p.y - cyp, len = Math.hypot(dx, dy) || 1;
        var lx = p.x + (dx / len) * 14, ly = p.y + (dy / len) * 14;
        ctx.textAlign = dx > 6 ? "left" : dx < -6 ? "right" : "center";
        ctx.textBaseline = "middle";
        ctx.fillText(axes[i].label, lx, ly);
      });
    }

    function renderFlat() {
      var R = radius() * 1.15;
      var cx = W / 2, cy = H / 2, t = st.selected;
      var levels = [20, 40, 60, 80, 100];
      // grid rings
      levels.forEach(function (lv) {
        ctx.beginPath();
        for (var i = 0; i <= N; i++) {
          var ang = -Math.PI / 2 + TAU * (i % N) / N;
          var rr = R * lv / 100;
          var x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = lv === 100 ? COLORS.gridStrong : COLORS.grid; ctx.lineWidth = 1; ctx.stroke();
      });
      // spokes + labels
      ctx.font = "12px system-ui, sans-serif"; ctx.fillStyle = COLORS.muted; ctx.textBaseline = "middle";
      for (var i = 0; i < N; i++) {
        var ang = -Math.PI / 2 + TAU * i / N;
        var ex = cx + Math.cos(ang) * R, ey = cy + Math.sin(ang) * R;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.strokeStyle = COLORS.grid; ctx.stroke();
        var lx = cx + Math.cos(ang) * (R + 16), ly = cy + Math.sin(ang) * (R + 16);
        ctx.textAlign = Math.cos(ang) > 0.2 ? "left" : Math.cos(ang) < -0.2 ? "right" : "center";
        ctx.fillStyle = COLORS.ink; ctx.fillText(axes[i].label, lx, ly);
      }
      // polygon
      var avg = avgScore(t);
      ctx.beginPath();
      for (var k = 0; k < N; k++) {
        var a2 = -Math.PI / 2 + TAU * k / N;
        var sc = clamp(num(measurements[t].scores[axes[k].key]), 0, 100);
        var rr2 = R * sc / 100;
        var x = cx + Math.cos(a2) * rr2, y = cy + Math.sin(a2) * rr2;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(39,95,85,0.16)"; ctx.fill();
      ctx.strokeStyle = COLORS.teal; ctx.lineWidth = 2; ctx.stroke();
      // vertices with band color
      for (var v = 0; v < N; v++) {
        var a3 = -Math.PI / 2 + TAU * v / N;
        var sc2 = clamp(num(measurements[t].scores[axes[v].key]), 0, 100);
        var rr3 = R * sc2 / 100;
        var x = cx + Math.cos(a3) * rr3, y = cy + Math.sin(a3) * rr3;
        var dv = detOf(t, axes[v].key), weakv = dv.band ? (dv.band === "blocked" || dv.band === "constrained") : sc2 < BANDS.watch;
        if (weakv) { ctx.beginPath(); ctx.arc(x, y, 7.5, 0, TAU); ctx.strokeStyle = "#d8a657"; ctx.lineWidth = 2; ctx.stroke(); }   // Von Restorff: weak axes pop
        ctx.beginPath(); ctx.arc(x, y, 4, 0, TAU); ctx.fillStyle = bandColor(sc2);
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
      }
      // center label
      ctx.fillStyle = COLORS.ink; ctx.font = "700 13px system-ui, sans-serif"; ctx.textAlign = "center";
      ctx.fillText(measurements[t].timestamp, cx, cy - 6);
      ctx.fillStyle = COLORS.muted; ctx.font = "11px system-ui, sans-serif";
      ctx.fillText("avg " + avg, cx, cy + 10);
    }

    function avgScore(t) {
      var s = 0; for (var i = 0; i < N; i++) s += clamp(num(measurements[t].scores[axes[i].key]), 0, 100);
      return Math.round(s / (N || 1));
    }

    // ---- side panel (causal) ----
    function renderSide() {
      var t = st.selected, m = measurements[t];
      var prev = t > 0 ? measurements[t - 1] : null;
      var html = "";
      html += '<div class="sr3d-when"><b>' + esc(m.timestamp) + "</b>" + (m.label ? " · " + esc(m.label) : "") + "</div>";
      html += '<div class="sr3d-avg">Average <strong>' + avgScore(t) + "</strong>/100" +
        (prev ? deltaChip(avgScore(t) - avgScore(t - 1)) : "") + "</div>";

      if (prev) {
        var deltas = axes.map(function (ax) {
          return { label: ax.label, d: num(m.scores[ax.key]) - num(prev.scores[ax.key]) };
        }).filter(function (x) { return x.d !== 0; }).sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); });
        html += '<div class="sr3d-sec">Movement vs ' + esc(prev.timestamp) + "</div>";
        if (deltas.length) {
          html += '<ul class="sr3d-deltas">';
          deltas.slice(0, 6).forEach(function (x) {
            var cls = x.d > 0 ? "up" : "down";
            html += "<li><span>" + esc(x.label) + "</span>" + '<b class="' + cls + '">' + (x.d > 0 ? "+" : "") + x.d + "</b></li>";
          });
          html += "</ul>";
        } else { html += '<div class="sr3d-empty">No score change.</div>'; }
      } else {
        html += '<div class="sr3d-sec">Baseline</div><div class="sr3d-empty">First measurement — nothing to compare against yet.</div>';
      }

      var changes = m.changes || [];
      html += '<div class="sr3d-sec">What changed' + (prev ? " this window" : "") + "</div>";
      if (changes.length) {
        html += '<ul class="sr3d-changes">';
        changes.forEach(function (c) {
          var tgts = (c.targets || []).map(function (k) {
            var ax = axes.filter(function (a) { return a.key === k; })[0]; return ax ? ax.label : k;
          });
          html += "<li>" +
            '<span class="sr3d-status ' + (c.status === "confirmed" ? "ok" : "sug") + '">' +
            (c.status === "confirmed" ? "confirmed" : "suggested") + "</span>" +
            '<div class="sr3d-what">' + esc(c.what || "(unlabeled change)") + "</div>" +
            (tgts.length ? '<div class="sr3d-tgt">→ ' + esc(tgts.join(", ")) + "</div>" : "") +
            (c.source ? '<div class="sr3d-src">' + esc(c.source) + "</div>" : "") +
            "</li>";
        });
        html += "</ul>";
      } else {
        html += '<div class="sr3d-empty">No changes recorded for this window.</div>';
      }
      side.innerHTML = html;
    }
    function deltaChip(d) {
      if (!d) return "";
      var cls = d > 0 ? "up" : "down";
      return ' <span class="sr3d-dchip ' + cls + '">' + (d > 0 ? "+" : "") + d + "</span>";
    }

    function renderChips() {
      chips.innerHTML = "";
      measurements.forEach(function (m, i) {
        var c = el("button", "sr3d-chip" + (i === st.selected ? " active" : ""), esc(m.timestamp));
        c.type = "button"; c.dataset.i = i;
        chips.appendChild(c);
      });
    }

    // ---- band labels + confidence helpers ----
    function bandLabel(s) { return s >= BANDS.good ? "Strong" : s >= BANDS.watch ? "Watch" : "Risk"; }
    function bandKey(s) { return s >= BANDS.good ? "good" : s >= BANDS.watch ? "watch" : "risk"; }
    function confClass(c) { c = String(c || ""); if (/partial/.test(c)) return "mid"; if (/block|unverified|missing|none|unknown/.test(c)) return "low"; if (/verified|fully|complete/.test(c)) return "ok"; return "mid"; }
    function detOf(t, key) { return ((measurements[t].detail || {})[key]) || {}; }
    function titleCase(s) { return String(s || "").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

    // ---- ranked bar-rail: radar gives gestalt (shape); a sorted bar list gives the
    // exact ranking the radar's angle/area can't. Weakest / blocked axes are flagged
    // (Von Restorff) and a confidence dot per axis surfaces trust. Rows open the drill. ----
    function renderRank() {
      var t = st.selected, m = measurements[t], hasDetail = !!m.detail;
      var rows = axes.map(function (a, i) {
        return { i: i, label: a.label, key: a.key, s: clamp(num(m.scores[a.key]), 0, 100), band: detOf(t, a.key).band, conf: detOf(t, a.key).confidence };
      }).sort(function (x, y) { return y.s - x.s; });
      var html = '<div class="sr3d-rank-h"><span>Where you stand</span><span class="sr3d-rank-sub">' + esc(m.timestamp) + " · ranked by score" + (hasDetail ? " · dot = confidence" : "") + "</span></div>";
      html += '<div class="sr3d-rank-grid">';
      rows.forEach(function (r, idx) {
        var weak = r.band ? (r.band === "blocked" || r.band === "constrained") : r.s < BANDS.watch;
        var has = (subm[r.key] || []).length;
        html += '<button class="sr3d-rank-row' + (weak ? " weak" : "") + (has ? " drillable" : "") + '" data-i="' + r.i + '" type="button">' +
          '<span class="sr3d-rank-n">' + (idx + 1) + "</span>" +
          '<span class="sr3d-rank-lab">' + esc(r.label) + "</span>" +
          '<span class="sr3d-rank-bar"><span style="width:' + r.s + "%;background:" + bandColor(r.s) + '"></span></span>' +
          '<span class="sr3d-rank-sc" style="color:' + bandColor(r.s) + '">' + r.s + "</span>" +
          (r.conf ? '<span class="sr3d-rank-dot ' + confClass(r.conf) + '" title="' + esc(r.conf.replace(/_/g, " ")) + '"></span>' : '<span class="sr3d-rank-dot none"></span>') +
          "</button>";
      });
      html += "</div>";
      rank.innerHTML = html;
      if (m.real && m.confidence) { badge.hidden = false; badge.className = "sr3d-runbadge live"; badge.textContent = "● live · " + m.confidence.replace(/_/g, " "); }
      else if (m.synthetic) { badge.hidden = false; badge.className = "sr3d-runbadge demo"; badge.textContent = "demo history"; }
      else { badge.hidden = true; }
    }
    rank.addEventListener("click", function (e) { var b = e.target.closest(".sr3d-rank-row"); if (b) openDrill(+b.dataset.i); });

    // ---- drill-down: per-axis sub-spider (submetrics + provenance) ----
    // Detail-on-demand over the overview: a focused sub-radar of the axis's submetrics
    // (radius = score, node size proportional to weight), "where this comes from"
    // (evidence systems), highest-lift submetric, day-one action, and confidence caveat.
    function subRadarSVG(list) {
      var cx = 170, cy = 158, R = 116, n = list.length;
      function A(i) { return -Math.PI / 2 + TAU * i / n; }
      var svg = "", i, a, rr, x, y;
      [25, 50, 75, 100].forEach(function (lv) {
        var d = ""; for (var k = 0; k <= n; k++) { var aa = A(k % n), r = R * lv / 100; d += (k ? "L" : "M") + (cx + Math.cos(aa) * r).toFixed(1) + " " + (cy + Math.sin(aa) * r).toFixed(1) + " "; }
        svg += '<path d="' + d + 'Z" fill="none" stroke="' + (lv === 100 ? "#c4d2c8" : "#e6ece6") + '" stroke-width="1"/>';
      });
      for (i = 0; i < n; i++) { a = A(i); svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx + Math.cos(a) * R).toFixed(1) + '" y2="' + (cy + Math.sin(a) * R).toFixed(1) + '" stroke="#e6ece6" stroke-width="1"/>'; }
      var poly = ""; for (i = 0; i < n; i++) { a = A(i); rr = R * clamp(num(list[i].score), 0, 100) / 100; poly += (i ? "L" : "M") + (cx + Math.cos(a) * rr).toFixed(1) + " " + (cy + Math.sin(a) * rr).toFixed(1) + " "; }
      svg += '<path d="' + poly + 'Z" fill="rgba(39,95,85,.14)" stroke="#275f55" stroke-width="2" stroke-linejoin="round"/>';
      for (i = 0; i < n; i++) { a = A(i); var s = clamp(num(list[i].score), 0, 100); rr = R * s / 100; x = cx + Math.cos(a) * rr; y = cy + Math.sin(a) * rr; var wr = 3 + 4 * (clamp(num(list[i].weight), 0, 20) / 20); svg += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + wr.toFixed(1) + '" fill="' + bandColor(s) + '" stroke="#fff" stroke-width="1.5"/>'; var lx = cx + Math.cos(a) * (R + 13), ly = cy + Math.sin(a) * (R + 13); svg += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" font-size="11" font-weight="800" fill="#46524b" text-anchor="middle" dominant-baseline="central">' + (i + 1) + "</text>"; }
      return '<svg class="sr3d-subradar" viewBox="0 0 340 312" role="img" aria-label="' + n + ' submetrics, radius = score, node size = weight">' + svg + "</svg>";
    }
    function openDrill(i) {
      var key = axes[i].key, list = (subm[key] || []).slice();
      if (!list.length) return;
      var t = st.selected, m = measurements[t], s = clamp(num(m.scores[key]), 0, 100), det = detOf(t, key);
      lastFocus = document.activeElement;
      var sysMap = {}; list.forEach(function (x) { (x.evidenceSystems || []).forEach(function (v) { sysMap[v] = 1; }); });
      var sysArr = Object.keys(sysMap);
      var hl = det.highestLift, hlItem = null; list.forEach(function (x) { if (x.key === hl) hlItem = x; });
      var hlLabel = hlItem ? hlItem.label : titleCase(hl);
      var h = '<div class="sr3d-drill-card" role="document">' +
        '<button class="sr3d-drill-x" type="button" aria-label="Close detail">×</button>' +
        '<div class="sr3d-drill-head"><div class="sr3d-drill-id"><div class="sr3d-drill-ax">' + esc(axes[i].label) + "</div>" +
        '<div class="sr3d-drill-meta">' + list.length + " submetrics" + (det.sourceWindow ? " · " + esc(det.sourceWindow) : "") + "</div></div>" +
        '<span class="sr3d-drill-score" style="color:' + bandColor(s) + '">' + s + "<span>/100</span></span>" +
        '<span class="sr3d-pill ' + bandKey(s) + '">' + bandLabel(s) + "</span>" +
        (det.confidence ? '<span class="sr3d-conf">' + esc(det.confidence.replace(/_/g, " ")) + "</span>" : "") +
        "</div>" +
        '<div class="sr3d-drill-body"><div class="sr3d-drill-left">' + subRadarSVG(list) + '</div><div class="sr3d-drill-right">';
      if (hl) h += '<div class="sr3d-drill-hl"><span class="sr3d-hl-tag">Highest lift</span><b>' + esc(hlLabel) + "</b></div>";
      if (det.dayOneTactic) h += '<div class="sr3d-drill-act"><div class="sr3d-drill-lbl">Day-one action</div><p>' + esc(det.dayOneTactic) + "</p></div>";
      if (sysArr.length) h += '<div class="sr3d-drill-prov"><div class="sr3d-drill-lbl">Where this comes from</div><div class="sr3d-prov-chips">' + sysArr.slice(0, 14).map(function (v) { return "<span>" + esc(v) + "</span>"; }).join("") + "</div></div>";
      h += "</div></div>";
      h += '<ol class="sr3d-drill-list">' + list.map(function (x, idx) {
        var ss = clamp(num(x.score), 0, 100);
        return '<li><span class="sr3d-li-n" style="background:' + bandColor(ss) + '">' + (idx + 1) + "</span>" +
          '<div class="sr3d-li-main"><div class="sr3d-li-top"><b>' + esc(x.label) + '</b><span class="sr3d-li-score" style="color:' + bandColor(ss) + '">' + ss + "</span></div>" +
          '<div class="sr3d-li-bar"><span style="width:' + ss + "%;background:" + bandColor(ss) + '"></span></div>' +
          ((x.sourceExamples || []).length ? '<div class="sr3d-li-src">' + esc(x.sourceExamples.join(" · ")) + "</div>" : "") +
          '</div><span class="sr3d-li-w" title="weight in the axis score">' + esc(x.weight) + "%</span></li>";
      }).join("") + "</ol>";
      if (det.whatCannotProve) h += '<div class="sr3d-drill-caveat"><b>Can\'t yet prove —</b> ' + esc(det.whatCannotProve) + "</div>";
      h += "</div>";
      drill.innerHTML = h;
      drill.hidden = false;
      var xb = drill.querySelector(".sr3d-drill-x"); if (xb) xb.focus();
    }
    function closeDrill() { if (drill.hidden) return; drill.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
    drill.addEventListener("click", function (e) { if (e.target === drill || e.target.closest(".sr3d-drill-x")) closeDrill(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !drill.hidden) closeDrill(); });
    function hitVertexFlat(e) {
      var pt = canvasPoint(e), R = radius() * 1.15, cx = W / 2, cy = H / 2, t = st.selected;
      for (var i = 0; i < N; i++) {
        var a = -Math.PI / 2 + TAU * i / N, sc = clamp(num(measurements[t].scores[axes[i].key]), 0, 100), rr = R * sc / 100;
        var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        if (Math.hypot(x - pt.x, y - pt.y) < 16) return i;
        var lx = cx + Math.cos(a) * (R + 16), ly = cy + Math.sin(a) * (R + 16);
        if (Math.hypot(lx - pt.x, ly - pt.y) < 42) return i;
      }
      return null;
    }

    // ---- interaction ----
    function setMode(mode, opts) {
      opts = opts || {};
      if (mode === st.mode && !opts.force) { render(); return; }
      if (mode === "flat") {
        st.autospin = false;
        if (st.mode === "3d" && M > 1 && !reduceMotion) {
          // fly the tube to face-on, then drop to the flat radar
          animateCamera({ yaw: 0, pitch: 0 }, 280, function () { flashSwitch(); st.mode = "flat"; render(); });
        } else { st.mode = "flat"; flashSwitch(); render(); }
      } else {
        st.mode = "3d"; flashSwitch();
        st.yaw = 0; st.pitch = 0;            // enter from the flat (face-on) orientation
        animateCamera({ yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH }, 420); // glide out to the default orbit
      }
    }
    function selectIndex(i) { st.selected = clamp(i, 0, M - 1); render(); }

    btn3d.addEventListener("click", function () { if (M > 1) setMode("3d"); });
    btnFlat.addEventListener("click", function () { setMode("flat"); });
    spin.addEventListener("click", function () { if (reduceMotion) return; st.autospin = !st.autospin; ensureLoop(); render(); });
    chips.addEventListener("click", function (e) {
      var b = e.target.closest(".sr3d-chip"); if (!b) return;
      selectIndex(+b.dataset.i);
    });

    canvas.addEventListener("pointerdown", function (e) {
      st.drag = { x: e.clientX, y: e.clientY }; st.moved = 0;
      st.vel.yaw = 0; st.vel.pitch = 0; st.anim = null; // grabbing cancels inertia / any tween
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!st.drag) return;
      var dx = e.clientX - st.drag.x, dy = e.clientY - st.drag.y;
      st.moved += Math.abs(dx) + Math.abs(dy);
      st.drag.x = e.clientX; st.drag.y = e.clientY;
      if (st.mode === "3d") {
        var dyaw = dx * 0.01, dpitch = dy * 0.01;
        st.yaw += dyaw; st.pitch = clamp(st.pitch + dpitch, -1.45, 1.45);
        st.vel.yaw = st.vel.yaw * 0.4 + dyaw * 0.6;   // smoothed velocity for release inertia
        st.vel.pitch = st.vel.pitch * 0.4 + dpitch * 0.6;
        render();
      }
    });
    canvas.addEventListener("pointerup", function (e) {
      var wasClick = st.moved < 6, was3d = st.mode === "3d"; st.drag = null;
      if (wasClick) {
        st.vel.yaw = 0; st.vel.pitch = 0;
        if (was3d) { var hit = hitRing(e); if (hit != null) { st.selected = hit; setMode("flat"); } }
        else { var hv = hitVertexFlat(e); if (hv != null && (subm[axes[hv].key] || []).length) { openDrill(hv); } else { setMode("3d"); } }
        return;
      }
      if (was3d && !reduceMotion) ensureLoop(); // glide on release
    });
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      st.zoom = clamp(st.zoom * (e.deltaY < 0 ? 1.08 : 0.92), 0.4, 3);
      render();
    }, { passive: false });

    function canvasPoint(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function hitRing(e) {
      var pt = canvasPoint(e);
      var rings = [];
      for (var t = 0; t < M; t++) {
        var poly = [], zsum = 0, cxp = 0, cyp = 0;
        for (var i = 0; i < N; i++) { var p = project(point3d(i, t)); poly.push(p); zsum += p.z; cxp += p.x; cyp += p.y; }
        rings.push({ t: t, poly: poly, z: zsum / N, cx: cxp / N, cy: cyp / N });
      }
      rings.sort(function (a, b) { return b.z - a.z; }); // nearest first
      for (var k = 0; k < rings.length; k++) if (pointInPoly(pt, rings[k].poly)) return rings[k].t;
      // forgiving fallback: nearest slice centroid within tolerance
      var best = null, bestD = Infinity;
      rings.forEach(function (r) { var d = Math.hypot(r.cx - pt.x, r.cy - pt.y); if (d < bestD) { bestD = d; best = r; } });
      if (best && bestD < radius() * st.zoom) return best.t;
      return null;
    }
    function pointInPoly(pt, poly) {
      var inside = false;
      for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        var hit = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-9) + xi);
        if (hit) inside = !inside;
      }
      return inside;
    }

    // Single rAF loop drives eased camera tweens, release inertia, and auto-spin.
    // It runs only while something is moving, then stops (no idle repaint).
    var looping = false;
    function ensureLoop() { if (!looping) { looping = true; global.requestAnimationFrame(tick); } }
    function tick() {
      var active = false;
      if (st.anim) {
        var p = clamp((nowMs() - st.anim.t0) / st.anim.dur, 0, 1);
        var e = easeOutQuint(p);
        st.yaw = lerp(st.anim.from.yaw, st.anim.to.yaw, e);
        st.pitch = lerp(st.anim.from.pitch, st.anim.to.pitch, e);
        st.zoom = lerp(st.anim.from.zoom, st.anim.to.zoom, e);
        renderCanvas();
        if (p >= 1) { var then = st.anim.then; st.anim = null; if (then) then(); }
        else active = true;
      } else {
        if (Math.abs(st.vel.yaw) > 0.0002 || Math.abs(st.vel.pitch) > 0.0002) {
          st.yaw += st.vel.yaw;
          st.pitch = clamp(st.pitch + st.vel.pitch, -1.45, 1.45);
          if (Math.abs(st.pitch) >= 1.45) st.vel.pitch = 0;
          st.vel.yaw *= 0.92; st.vel.pitch *= 0.92; // friction
          active = true;
        }
        var target = st.autospin ? 0.006 : 0;       // constant motion -> linear, with eased on/off ramp
        st.spinSpeed = lerp(st.spinSpeed, target, 0.08);
        if (st.spinSpeed > 0.0001) { st.yaw += st.spinSpeed; active = true; }
        if (active) renderCanvas();
      }
      if (active) global.requestAnimationFrame(tick); else looping = false;
    }

    function animateCamera(to, dur, then) {
      st.vel.yaw = 0; st.vel.pitch = 0;
      if (reduceMotion || dur <= 0) {
        if (to.yaw != null) st.yaw = to.yaw;
        if (to.pitch != null) st.pitch = to.pitch;
        if (to.zoom != null) st.zoom = to.zoom;
        render(); if (then) then(); return;
      }
      st.anim = {
        from: { yaw: st.yaw, pitch: st.pitch, zoom: st.zoom },
        to: { yaw: to.yaw != null ? to.yaw : st.yaw, pitch: to.pitch != null ? to.pitch : st.pitch, zoom: to.zoom != null ? to.zoom : st.zoom },
        t0: nowMs(), dur: dur, then: then || null
      };
      ensureLoop();
    }

    function flashSwitch() { // brief blur to mask the flat<->3d swap (Emil: blur bridges crossfades)
      canvas.classList.add("switching");
      global.setTimeout(function () { canvas.classList.remove("switching"); }, 180);
    }

    if (global.ResizeObserver) { new ResizeObserver(resize).observe(canvasWrap); }
    else { global.addEventListener("resize", resize); }
    resize();       // sizes + paints the canvas
    renderPanel();  // populate side + chips once (panel re-renders only on selection/mode/data changes)

    return {
      render: render,
      setMode: setMode,
      select: selectIndex,
      get state() { return st; }
    };
  }

  function mount(root, opts) {
    opts = opts || {};
    if (opts.timeline) return Promise.resolve(create(root, opts));
    if (!opts.dataUrl) throw new Error("ScanRadar3D.mount needs { timeline } or { dataUrl }");
    return fetch(opts.dataUrl, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " loading " + opts.dataUrl);
      return r.json();
    }).then(function (timeline) {
      return create(root, Object.assign({}, opts, { timeline: timeline }));
    }).catch(function (err) {
      root.innerHTML = '<div class="sr3d-error"><b>Could not load the timeline</b><p>' +
        esc(err.message) + " — expected <code>" + esc(opts.dataUrl) + "</code></p></div>";
      throw err;
    });
  }

  global.ScanRadar3D = { mount: mount, create: create };
})(window);
