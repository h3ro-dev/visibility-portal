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
  var SEQ = 0;                          // per-instance id seed (for aria wiring)
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

  // Cluster grouping (IA chunking): chunk the axes into a few groups and reorder so
  // each group is a contiguous arc. Cluster is a SEPARATE channel from health — a
  // named label (primary cue) + faint desaturated sector. Cool/muted palette clear
  // of the green/amber/red health scale. Override per-timeline via timeline.clusters.
  var DEFAULT_CLUSTERS = [
    { key: "foundation", label: "Foundation", color: "#44598a", axes: ["access", "crawl", "ia", "perf"] },
    { key: "credibility", label: "Credibility", color: "#7a566f", axes: ["proof", "authority", "trust", "local"] },
    { key: "demand", label: "Demand & Conversion", color: "#2f7d86", axes: ["demand", "aigeo", "cro", "attribution"] }
  ];
  function clusterOrder(rawAxes, clusters) {
    var byKey = {}; rawAxes.forEach(function (a) { byKey[a.key] = a; });
    var out = [], seen = {};
    clusters.forEach(function (c) { c.axes.forEach(function (k) { if (byKey[k]) { var a = {}; for (var p in byKey[k]) a[p] = byKey[k][p]; a.cluster = c; out.push(a); seen[k] = 1; } }); });
    rawAxes.forEach(function (a) { if (!seen[a.key]) { var b = {}; for (var q in a) b[q] = a[q]; b.cluster = null; out.push(b); } });
    return out;
  }
  function clusterSpans(axes) {
    var spans = [], cur = null;
    axes.forEach(function (a, i) {
      if (!a.cluster) { cur = null; return; }
      if (cur && cur.cluster === a.cluster) cur.end = i;
      else { cur = { cluster: a.cluster, start: i, end: i }; spans.push(cur); }
    });
    return spans;
  }

  function create(root, opts) {
    opts = opts || {};
    var uid = ++SEQ;
    var timeline = opts.timeline || { axes: [], measurements: [] };
    var axes = clusterOrder(timeline.axes || [], timeline.clusters || DEFAULT_CLUSTERS);
    var spans = clusterSpans(axes);
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
      anim: null,                   // active eased camera tween
      kbAxis: 0, focused: false     // keyboard: focused-axis cursor (flat) + canvas-focus flag
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
    canvas.tabIndex = 0;                                   // keyboard-focusable
    canvas.setAttribute("role", "application");            // arrow keys pass through to our handler
    canvas.setAttribute("aria-roledescription", "interactive radar");
    canvas.setAttribute("aria-describedby", "sr3d-help-" + uid);
    canvasWrap.appendChild(canvas);
    var side = el("aside", "sr3d-side");
    stage.appendChild(canvasWrap); stage.appendChild(side);

    var chips = el("div", "sr3d-chips");
    var rank = el("div", "sr3d-rank"); rank.setAttribute("aria-label", "Axes ranked by score");
    var drill = el("div", "sr3d-drill"); drill.hidden = true;
    drill.setAttribute("role", "dialog"); drill.setAttribute("aria-modal", "true"); drill.setAttribute("aria-label", "Submetric detail");
    var subm = timeline.submetrics || {};
    var lastFocus = null;

    // ---- screen-reader layer for the canvas (the one canvas-only surface; the rank
    // rail + chips are already DOM-accessible, this gives the chart itself parity) ----
    var srLive = el("div", "sr3d-sr"); srLive.setAttribute("role", "status"); srLive.setAttribute("aria-live", "polite");
    var srHelp = el("p", "sr3d-sr"); srHelp.id = "sr3d-help-" + uid;
    srHelp.textContent = "Interactive radar. In the 3D view, arrow keys orbit and plus or minus zoom. In the flat view, left and right arrows move between the axes and Enter opens an axis's detail. Page Up and Page Down change the scan; Escape returns to the 3D view. The ranked list below the chart opens the same axis details.";

    root.appendChild(bar); root.appendChild(stage); root.appendChild(rank); root.appendChild(chips); root.appendChild(drill);
    root.appendChild(srLive); root.appendChild(srHelp);

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
    function renderPanel() { renderSide(); renderChips(); renderRank(); updateCanvasAria(); }
    function render() { renderCanvas(); renderPanel(); }

    function emptyMsg(msg) {
      ctx.fillStyle = COLORS.muted; ctx.font = "14px system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.fillText(msg, W / 2, H / 2);
    }

    function render3d() {
      var faces = [];
      st.nodes3d = [];   // pick buffer: every ring vertex's screen pos {x,y,z,axis i,scan t}, rebuilt each frame so clicks stay correct while orbiting
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
          f.pts.forEach(function (pt, ai) {
            st.nodes3d.push({ x: pt.x, y: pt.y, z: pt.z, i: ai, t: f.t });
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
      // faint cluster sectors behind the grid (separate channel from health)
      spans.forEach(function (sp) {
        var a0 = -Math.PI / 2 + TAU * (sp.start - 0.5) / N, a1 = -Math.PI / 2 + TAU * (sp.end + 0.5) / N;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R * 1.02, a0, a1); ctx.closePath();
        ctx.fillStyle = sp.cluster.color; ctx.globalAlpha = 0.07; ctx.fill(); ctx.globalAlpha = 1;
      });
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
      // cluster name labels at each arc midpoint (further out than axis labels)
      ctx.font = "800 12px Inter, system-ui, sans-serif";
      spans.forEach(function (sp) {
        var mid = -Math.PI / 2 + TAU * (sp.start + sp.end) / 2 / N;
        var lx = cx + Math.cos(mid) * (R + 46), ly = cy + Math.sin(mid) * (R + 46);
        ctx.fillStyle = sp.cluster.color; ctx.textAlign = Math.cos(mid) > 0.2 ? "left" : Math.cos(mid) < -0.2 ? "right" : "center";
        ctx.fillText(sp.cluster.label, lx, ly);
      });
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
      // keyboard focus cursor: ring the focused axis + emphasize its label
      if (st.focused) {
        var fa = -Math.PI / 2 + TAU * st.kbAxis / N;
        var fsc = clamp(num(measurements[t].scores[axes[st.kbAxis].key]), 0, 100), fr = R * fsc / 100;
        var fx = cx + Math.cos(fa) * fr, fy = cy + Math.sin(fa) * fr;
        ctx.beginPath(); ctx.arc(fx, fy, 11, 0, TAU); ctx.strokeStyle = COLORS.teal; ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
        var flx = cx + Math.cos(fa) * (R + 16), fly = cy + Math.sin(fa) * (R + 16);
        ctx.font = "800 12px Inter, system-ui, sans-serif"; ctx.fillStyle = COLORS.teal; ctx.textBaseline = "middle";
        ctx.textAlign = Math.cos(fa) > 0.2 ? "left" : Math.cos(fa) < -0.2 ? "right" : "center";
        ctx.fillText(axes[st.kbAxis].label, flx, fly);
      }
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
    function clusterAvg(sp, t) { var s = 0, n = 0; for (var i = sp.start; i <= sp.end; i++) { s += clamp(num(measurements[t].scores[axes[i].key]), 0, 100); n++; } return Math.round(s / (n || 1)); }
    function renderRank() {
      var t = st.selected, m = measurements[t], hasDetail = !!m.detail;
      var strip = spans.length ? '<div class="sr3d-cluster-strip">' + spans.map(function (sp) {
        var av = clusterAvg(sp, t);
        return '<div class="sr3d-cluster-card" style="--cl:' + sp.cluster.color + '">' +
          '<div class="sr3d-cluster-top"><span class="sr3d-cluster-name">' + esc(sp.cluster.label) + '</span><span class="sr3d-cluster-avg" style="color:' + bandColor(av) + '">' + av + "</span></div>" +
          '<div class="sr3d-cluster-bar"><span style="width:' + av + '%"></span></div>' +
          '<div class="sr3d-cluster-axes">' + esc(axes.slice(sp.start, sp.end + 1).map(function (a) { return a.label; }).join(" · ")) + "</div>" +
          "</div>";
      }).join("") + "</div>" : "";
      var rows = axes.map(function (a, i) {
        return { i: i, label: a.label, key: a.key, cl: a.cluster, s: clamp(num(m.scores[a.key]), 0, 100), band: detOf(t, a.key).band, conf: detOf(t, a.key).confidence };
      }).sort(function (x, y) { return y.s - x.s; });
      var html = strip + '<div class="sr3d-rank-h"><span>Where you stand</span><span class="sr3d-rank-sub">' + esc(m.timestamp) + " · ranked by score" + (hasDetail ? " · dot = confidence" : "") + "</span></div>";
      html += '<div class="sr3d-rank-grid">';
      rows.forEach(function (r, idx) {
        var weak = r.band ? (r.band === "blocked" || r.band === "constrained") : r.s < BANDS.watch;
        var has = (subm[r.key] || []).length;
        html += '<button class="sr3d-rank-row' + (weak ? " weak" : "") + (has ? " drillable" : "") + '" data-i="' + r.i + '" type="button">' +
          '<span class="sr3d-rank-n">' + (idx + 1) + "</span>" +
          '<span class="sr3d-rank-cl" style="background:' + (r.cl ? r.cl.color : "transparent") + '" title="' + (r.cl ? esc(r.cl.label) : "") + '"></span>' +
          '<span class="sr3d-rank-lab">' + esc(r.label) + "</span>" +
          '<span class="sr3d-rank-bar"><span style="width:' + r.s + "%;background:" + bandColor(r.s) + '"></span></span>' +
          '<span class="sr3d-rank-sc" style="color:' + bandColor(r.s) + '">' + r.s + "</span>" +
          (r.conf ? '<span class="sr3d-rank-dot ' + confClass(r.conf) + '" role="img" aria-label="confidence: ' + esc(r.conf.replace(/_/g, " ")) + '" title="' + esc(r.conf.replace(/_/g, " ")) + '"></span>' : '<span class="sr3d-rank-dot none" role="img" aria-label="confidence: not set"></span>') +
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
    // a submetric's value at a given scan: prefer its history[run]; fall back to the current .score
    function scoreAtRun(item, run) {
      if (item && item.history && run != null && run >= 0 && run < item.history.length && item.history[run] != null && item.history[run] !== "") return num(item.history[run]);
      return num(item ? item.score : 0);
    }
    function subRadarSVG(list, hi, runIdx) {
      if (hi == null) hi = -1;   // index of the submetric to spotlight (the open trend), or -1
      var cx = 170, cy = 158, R = 116, n = list.length;
      function A(i) { return -Math.PI / 2 + TAU * i / n; }
      var svg = "", i, a, rr, x, y;
      [25, 50, 75, 100].forEach(function (lv) {
        var d = ""; for (var k = 0; k <= n; k++) { var aa = A(k % n), r = R * lv / 100; d += (k ? "L" : "M") + (cx + Math.cos(aa) * r).toFixed(1) + " " + (cy + Math.sin(aa) * r).toFixed(1) + " "; }
        svg += '<path d="' + d + 'Z" fill="none" stroke="' + (lv === 100 ? "#c4d2c8" : "#e6ece6") + '" stroke-width="1"/>';
      });
      for (i = 0; i < n; i++) { a = A(i); svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx + Math.cos(a) * R).toFixed(1) + '" y2="' + (cy + Math.sin(a) * R).toFixed(1) + '" stroke="#e6ece6" stroke-width="1"/>'; }
      var poly = ""; for (i = 0; i < n; i++) { a = A(i); rr = R * clamp(scoreAtRun(list[i], runIdx), 0, 100) / 100; poly += (i ? "L" : "M") + (cx + Math.cos(a) * rr).toFixed(1) + " " + (cy + Math.sin(a) * rr).toFixed(1) + " "; }
      svg += '<path d="' + poly + 'Z" fill="rgba(39,95,85,.14)" stroke="#275f55" stroke-width="2" stroke-linejoin="round"/>';
      for (i = 0; i < n; i++) {
        a = A(i); var s = clamp(scoreAtRun(list[i], runIdx), 0, 100); rr = R * s / 100; x = cx + Math.cos(a) * rr; y = cy + Math.sin(a) * rr;
        var wr = 3 + 4 * (clamp(num(list[i].weight), 0, 20) / 20), on = i === hi;
        if (on) svg += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (wr + 4).toFixed(1) + '" fill="none" stroke="' + bandColor(s) + '" stroke-width="2"/>';
        svg += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (on ? wr + 1.5 : wr).toFixed(1) + '" fill="' + bandColor(s) + '" stroke="#fff" stroke-width="1.5"/>';
        var lx = cx + Math.cos(a) * (R + 13), ly = cy + Math.sin(a) * (R + 13);
        svg += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" font-size="11" font-weight="' + (on ? 900 : 800) + '" fill="' + (on ? bandColor(s) : "#46524b") + '" text-anchor="middle" dominant-baseline="central">' + (i + 1) + "</text>";
        svg += '<circle class="sr3d-sub-node" data-sub="' + i + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (wr + 7).toFixed(1) + '" fill="transparent"><title>' + esc(list[i].label) + ' — click for its trend</title></circle>';
      }
      return '<svg class="sr3d-subradar" viewBox="0 0 340 312" role="img" aria-label="' + n + ' submetrics, radius = score, node size = weight">' + svg + "</svg>";
    }
    function historySpark(row, selectedIndex) {
      var vals = (row.history || []).map(function (v) { return v == null || v === "" ? null : num(v); });
      if (vals.filter(function (v) { return v != null; }).length < 2) return "";
      var w = 112, h = 30, pad = 3, max = 100, min = 0;
      function X(i) { return pad + (w - pad * 2) * (i / Math.max(1, vals.length - 1)); }
      function Y(v) { return h - pad - (h - pad * 2) * ((clamp(v, min, max) - min) / (max - min)); }
      var open = false;
      var d = vals.map(function (v, i) {
        if (v == null) { open = false; return ""; }
        var cmd = open ? "L" : "M"; open = true;
        return cmd + X(i).toFixed(1) + " " + Y(v).toFixed(1);
      }).filter(Boolean).join(" ");
      var circles = vals.map(function (v, i) {
        if (v == null) return "";
        var active = i === selectedIndex;
        return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(v).toFixed(1) + '" r="' + (active ? "2.8" : "1.8") + '" fill="' + (active ? bandColor(v) : "#7f8b85") + '" stroke="#fff" stroke-width="' + (active ? "1.2" : "0") + '"/>';
      }).join("");
      return '<div class="sr3d-li-history"><span>History</span><svg viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="' + esc(row.label) + " history: " + esc(vals.map(function (v) { return v == null ? "missing" : v; }).join(", ")) + '"><path d="' + d + '" fill="none" stroke="#275f55" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' + circles + "</svg></div>";
    }

    // ---- "mountain range" time-series: an axis (or submetric) score across every scan.
    // The row sparkline (historySpark) is the at-a-glance read; clicking a row expands
    // its full trend here — overview (sub-spider) → zoom/filter (rows) → details (range). ----
    function mountainSVG(values, labels, selIdx, color) {
      var W = 520, H = 134, pL = 10, pR = 10, pT = 12, pB = 22, n = values.length, plotH = H - pT - pB;
      function X(k) { return n <= 1 ? W / 2 : pL + (W - pL - pR) * (k / (n - 1)); }
      function Y(v) { return pT + plotH * (1 - clamp(num(v), 0, 100) / 100); }
      var pts = values.map(function (v, k) { return [X(k), Y(v)]; });
      var g = '<svg class="sr3d-mtn" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="score over ' + n + ' scans">';
      [25, 50, 75].forEach(function (lv) { var y = Y(lv); g += '<line x1="' + pL + '" y1="' + y.toFixed(1) + '" x2="' + (W - pR) + '" y2="' + y.toFixed(1) + '" stroke="#eef2ee" stroke-width="1"/>'; });
      if (n > 1) {
        var base = H - pB;
        g += '<path d="M' + pts[0][0].toFixed(1) + " " + base + " L" + pts.map(function (p) { return p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" L") + " L" + pts[n - 1][0].toFixed(1) + " " + base + ' Z" fill="' + color + '" fill-opacity="0.13"/>';
        g += '<path d="' + pts.map(function (p, k) { return (k ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ") + '" fill="none" stroke="' + color + '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>';
      }
      pts.forEach(function (p, k) { var sel = k === selIdx; g += '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (sel ? 4.5 : 2.6) + '" fill="' + (sel ? color : "#fff") + '" stroke="' + color + '" stroke-width="' + (sel ? 2 : 1.6) + '"/>'; });
      var show = []; [0, n - 1, (selIdx >= 0 && selIdx < n) ? selIdx : n - 1].forEach(function (k) { if (show.indexOf(k) < 0) show.push(k); });
      g += '<g font-size="9" fill="#7a847d">';
      show.forEach(function (k) { if (k < 0 || k >= n) return; var anchor = k === 0 ? "start" : k === n - 1 ? "end" : "middle"; g += '<text x="' + X(k).toFixed(1) + '" y="' + (H - 7) + '" text-anchor="' + anchor + '">' + esc(labels[k] || "") + "</text>"; });
      return g + "</g></svg>";
    }
    function explainerText(values, labels) {
      var n = values.length;
      if (n <= 1) return "Single scan so far — the trend fills in as runs accumulate.";
      var first = clamp(num(values[0]), 0, 100), last = clamp(num(values[n - 1]), 0, 100), d = last - first;
      var bi = 1, bd = 0; for (var k = 1; k < n; k++) { var step = clamp(num(values[k]), 0, 100) - clamp(num(values[k - 1]), 0, 100); if (Math.abs(step) > Math.abs(bd)) { bd = step; bi = k; } }
      return '<b style="color:' + bandColor(last) + '">' + last + '</b> now · <b class="' + (d > 0 ? "up" : d < 0 ? "down" : "") + '">' + (d > 0 ? "+" + d : d) + "</b> since " + esc(labels[0] || "start") +
        (bd ? ' · biggest move <b class="' + (bd > 0 ? "up" : "down") + '">' + (bd > 0 ? "+" + bd : bd) + "</b> (" + esc(labels[bi - 1] || "") + "→" + esc(labels[bi] || "") + ")" : "");
    }

    var drillState = null;   // { i, list, sub }  — sub = submetric index, or -1 (whole axis)
    function renderDrillTime() {
      if (!drillState) return;
      var i = drillState.i, list = drillState.list, sub = drillState.sub, labels = measurements.map(function (mm) { return mm.timestamp; });
      var values, color, name;
      var run = (drillState.run != null) ? drillState.run : st.selected;   // the scan this drill is anchored to (the dot you clicked)
      if (sub >= 0) { var sm = list[sub]; values = (sm.history && sm.history.length) ? sm.history : [clamp(num(sm.score), 0, 100)]; color = bandColor(clamp(scoreAtRun(sm, run), 0, 100)); name = sm.label; }
      else { var key = axes[i].key; values = measurements.map(function (mm) { return clamp(num(mm.scores[key]), 0, 100); }); color = bandColor(clamp(num(measurements[run].scores[key]), 0, 100)); name = "Whole axis"; }
      var useLabels = values.length === labels.length ? labels : labels.slice(-values.length);
      var selOnLine = (values.length === labels.length) ? run : values.length - 1;   // keep the highlight valid if a submetric's history is shorter than the run set
      var tEl = drill.querySelector(".sr3d-drill-time");
      if (tEl) tEl.innerHTML = '<div class="sr3d-drill-lbl">Over time · ' + esc(name) + (sub >= 0 ? ' <button class="sr3d-time-back" type="button">← whole axis</button>' : "") + "</div>" +
        mountainSVG(values, useLabels, selOnLine, color) + '<div class="sr3d-time-exp">' + explainerText(values, useLabels) + "</div>";
      var lEl = drill.querySelector(".sr3d-drill-left"); if (lEl) lEl.innerHTML = subRadarSVG(list, sub, run);
      var rows = drill.querySelectorAll(".sr3d-li"); for (var r = 0; r < rows.length; r++) rows[r].classList.toggle("active", r === sub);
      var isEl = drill.querySelector(".sr3d-drill-issues"); if (isEl) isEl.innerHTML = issuesHTML(axes[i].key, axes[i].label, list, sub);
    }
    function showSeries(sub) { if (drillState) { drillState.sub = sub; renderDrillTime(); } }

    // ---- issue layer: the agent-ready work bound to each metric (URLs + repo issue + realized impact).
    // timeline.issues[axisKey][submetricKey | "_axis"] = [{ title, intent, goal, severity, actionType,
    //   urls:[{url,problem}], github:{number,url,state}|null, impact:{before,after,delta}|null, status }] ----
    var issuesData = timeline.issues || {};
    var SEV = { P0: "p0", P1: "p1", P2: "p2", P3: "p3" };
    function sevCls(s) { return SEV[String(s || "P2").toUpperCase()] || "p2"; }
    function sevRank(s) { var k = String(s || "P2").toUpperCase(); return k === "P0" ? 0 : k === "P1" ? 1 : k === "P3" ? 3 : 2; }
    function shortUrl(u) { try { var x = new URL(u); return x.hostname.replace(/^www\./, "") + (x.pathname === "/" ? "" : x.pathname); } catch (e) { return String(u).replace(/^https?:\/\//, ""); } }
    function issuesForSub(axisKey, list, sub) {
      var byAxis = issuesData[axisKey] || {}, out = [];
      function add(it, smLabel) { var c = {}; for (var k in it) c[k] = it[k]; c._sm = smLabel; out.push(c); }
      if (sub != null && sub >= 0) { var smk = list[sub] && list[sub].key; (byAxis[smk] || []).forEach(function (it) { add(it, list[sub] && list[sub].label); }); }
      else { (byAxis._axis || []).forEach(function (it) { add(it, "Whole axis"); }); list.forEach(function (sm) { (byAxis[sm.key] || []).forEach(function (it) { add(it, sm.label); }); }); }
      out.sort(function (a, b) { return sevRank(a.severity) - sevRank(b.severity); });
      return out;
    }
    function issuesHTML(axisKey, axisLabel, list, sub) {
      var arr = issuesForSub(axisKey, list, sub), whole = !(sub != null && sub >= 0);
      var scope = whole ? esc(axisLabel) : esc(axisLabel) + " / " + esc(list[sub].label);
      var head = '<div class="sr3d-drill-lbl sr3d-issues-lbl">Issues to fix — ' + scope + ' <span class="sr3d-issues-n">' + arr.length + "</span></div>";
      if (!arr.length) return head + '<div class="sr3d-issues-empty">No issues filed for this metric yet — they appear here as the audit writes them to the repo.</div>';
      var body = arr.slice(0, 8).map(function (it) {
        var urls = (it.urls || []).map(function (u) { return '<div class="sr3d-issue-url"><a href="' + esc(u.url) + '" target="_blank" rel="noopener noreferrer">' + esc(shortUrl(u.url)) + ' ↗</a>' + (u.problem ? '<span class="sr3d-issue-prob">' + esc(u.problem) + "</span>" : "") + "</div>"; }).join("");
        var gh = (it.github && it.github.url) ? '<a class="sr3d-issue-gh" href="' + esc(it.github.url) + '" target="_blank" rel="noopener noreferrer">#' + esc(String(it.github.number || "")) + " · " + esc(it.github.state || "open") + " ↗</a>" : '<span class="sr3d-issue-gh none">not yet filed</span>';
        var d = (it.impact && it.impact.delta != null) ? num(it.impact.delta) : null;
        var imp = d != null ? '<span class="sr3d-issue-impact ' + (d > 0 ? "up" : d < 0 ? "down" : "") + '">' + (d > 0 ? "+" + d : d) + (it.impact.before != null ? " (" + esc(String(it.impact.before)) + "→" + esc(String(it.impact.after)) + ")" : "") + "</span>" : "";
        return '<div class="sr3d-issue ' + sevCls(it.severity) + '">' +
          '<div class="sr3d-issue-top"><span class="sr3d-sev ' + sevCls(it.severity) + '">' + esc(String(it.severity || "P2").toUpperCase()) + '</span><b class="sr3d-issue-title">' + esc(it.title || "(untitled)") + "</b>" + (it.actionType ? '<span class="sr3d-issue-type">' + esc(it.actionType) + "</span>" : "") + "</div>" +
          (whole && it._sm ? '<div class="sr3d-issue-sm">' + esc(it._sm) + "</div>" : "") +
          (it.intent ? '<div class="sr3d-issue-line"><span>Intent</span> ' + esc(it.intent) + "</div>" : "") +
          (it.goal ? '<div class="sr3d-issue-line"><span>Goal</span> ' + esc(it.goal) + "</div>" : "") +
          (urls ? '<div class="sr3d-issue-urls">' + urls + "</div>" : "") +
          '<div class="sr3d-issue-foot">' + gh + imp + (it.status ? '<span class="sr3d-issue-status">' + esc(it.status) + "</span>" : "") + "</div>" +
        "</div>";
      }).join("");
      var more = arr.length > 8 ? '<div class="sr3d-issues-more">+' + (arr.length - 8) + " more</div>" : "";
      return head + '<div class="sr3d-issues-list">' + body + more + "</div>";
    }

    function openDrill(i, runT) {
      var key = axes[i].key, list = (subm[key] || []).slice();
      if (!list.length) return;
      var t = (runT == null) ? st.selected : clamp(runT, 0, M - 1), m = measurements[t], s = clamp(num(m.scores[key]), 0, 100), det = detOf(t, key);
      lastFocus = document.activeElement;
      var sysMap = {}; list.forEach(function (x) { (x.evidenceSystems || []).forEach(function (v) { sysMap[v] = 1; }); });
      var sysArr = Object.keys(sysMap);
      var hl = det.highestLift, hlItem = null; list.forEach(function (x) { if (x.key === hl) hlItem = x; });
      var hlLabel = hlItem ? hlItem.label : titleCase(hl);
      var h = '<div class="sr3d-drill-card" role="document">' +
        '<button class="sr3d-drill-x" type="button" aria-label="Close detail">×</button>' +
        '<div class="sr3d-drill-head"><div class="sr3d-drill-id"><div class="sr3d-drill-ax">' + esc(axes[i].label) + "</div>" +
        '<div class="sr3d-drill-meta">' + (axes[i].cluster ? '<span class="sr3d-drill-cl" style="--cl:' + axes[i].cluster.color + '">' + esc(axes[i].cluster.label) + "</span> " : "") + list.length + " submetrics" + (det.sourceWindow ? " · " + esc(det.sourceWindow) : "") + "</div></div>" +
        '<span class="sr3d-drill-score" style="color:' + bandColor(s) + '">' + s + "<span>/100</span></span>" +
        '<span class="sr3d-pill ' + bandKey(s) + '">' + bandLabel(s) + "</span>" +
        (det.confidence ? '<span class="sr3d-conf">' + esc(det.confidence.replace(/_/g, " ")) + "</span>" : "") +
        "</div>" +
        // sub-spider (left) next to the time-series mountain range (right, filled by renderDrillTime)
        '<div class="sr3d-drill-body"><div class="sr3d-drill-left">' + subRadarSVG(list, -1, t) + '</div><div class="sr3d-drill-right sr3d-drill-time"></div></div>';
      var info = "";
      if (hl) info += '<div class="sr3d-drill-hl"><span class="sr3d-hl-tag">Highest lift</span><b>' + esc(hlLabel) + "</b></div>";
      if (det.dayOneTactic) info += '<div class="sr3d-drill-act"><div class="sr3d-drill-lbl">Day-one action</div><p>' + esc(det.dayOneTactic) + "</p></div>";
      if (sysArr.length) info += '<div class="sr3d-drill-prov"><div class="sr3d-drill-lbl">Where this comes from</div><div class="sr3d-prov-chips">' + sysArr.slice(0, 14).map(function (v) { return "<span>" + esc(v) + "</span>"; }).join("") + "</div></div>";
      if (info) h += '<div class="sr3d-drill-info">' + info + "</div>";
      h += '<div class="sr3d-drill-lbl sr3d-list-lbl">Submetrics — click a node on the spider (or a row) for its own trend</div><div class="sr3d-drill-list">' + list.map(function (x, idx) {
        var ss = clamp(scoreAtRun(x, t), 0, 100);
        return '<button class="sr3d-li" type="button" data-sub="' + idx + '"><span class="sr3d-li-n" style="background:' + bandColor(ss) + '">' + (idx + 1) + "</span>" +
          '<div class="sr3d-li-main"><div class="sr3d-li-top"><b>' + esc(x.label) + '</b><span class="sr3d-li-score" style="color:' + bandColor(ss) + '">' + ss + "</span></div>" +
          '<div class="sr3d-li-bar"><span style="width:' + ss + "%;background:" + bandColor(ss) + '"></span></div>' +
          historySpark(x, t) +
          ((x.sourceExamples || []).length ? '<div class="sr3d-li-src">' + esc(x.sourceExamples.join(" · ")) + "</div>" : "") +
          '</div><span class="sr3d-li-w" title="weight in the axis score">' + esc(x.weight) + "%</span></button>";
      }).join("") + "</div>";
      h += '<div class="sr3d-drill-issues"></div>';   // agent-ready issues for the selected metric (filled by renderDrillTime on sub change)
      if (det.whatCannotProve) h += '<div class="sr3d-drill-caveat"><b>Can\'t yet prove —</b> ' + esc(det.whatCannotProve) + "</div>";
      h += "</div>";
      drill.innerHTML = h;
      drillState = { i: i, list: list, sub: -1, run: t };   // start on the whole-axis trend, anchored to the clicked scan
      renderDrillTime();
      drill.hidden = false;
      var xb = drill.querySelector(".sr3d-drill-x"); if (xb) xb.focus();
    }
    function closeDrill() { if (drill.hidden) return; drill.hidden = true; drillState = null; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
    drill.addEventListener("click", function (e) {
      if (e.target === drill || e.target.closest(".sr3d-drill-x")) { closeDrill(); return; }
      if (e.target.closest(".sr3d-time-back")) { showSeries(-1); return; }       // back to whole-axis trend
      var sn = e.target.closest(".sr3d-sub-node");                                // a dot on the sub-spider → that submetric's trend (toggle off if already open)
      if (sn) { var si = +sn.dataset.sub; showSeries(drillState && drillState.sub === si ? -1 : si); return; }
      var row = e.target.closest(".sr3d-li"); if (row) { showSeries(+row.dataset.sub); }   // glance → expand this submetric
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !drill.hidden) closeDrill(); });
    drill.addEventListener("keydown", function (e) {   // focus trap: Tab cycles within the dialog
      if (e.key !== "Tab") return;
      var card = drill.querySelector(".sr3d-drill-card"); if (!card) return;
      var f = [].slice.call(card.querySelectorAll('button,a[href],[tabindex]:not([tabindex="-1"])')).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
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
        if (was3d) {
          var hn = hitNode3d(e);
          if (hn != null) {                                  // clicked a dot on the tube → drill that axis at that scan
            st.selected = hn.t;
            if ((subm[axes[hn.i].key] || []).length) { render(); openDrill(hn.i, hn.t); }
            else setMode("flat");                            // axis has no submetrics: just focus that scan flat
          } else { var hit = hitRing(e); if (hit != null) { st.selected = hit; setMode("flat"); } }
        }
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

    // ---- keyboard + screen-reader control of the canvas ----
    // Clearing then re-setting (next tick) reliably re-announces even identical text.
    function announce(msg) { srLive.textContent = ""; global.setTimeout(function () { srLive.textContent = msg; }, 30); }
    function updateCanvasAria() {
      if (!N || !M) { canvas.setAttribute("aria-label", "Visibility radar — no data"); return; }
      var m = measurements[st.selected] || {};
      canvas.setAttribute("aria-label", st.mode === "flat"
        ? "Visibility radar, flat view, " + (m.timestamp || "") + ", average " + avgScore(st.selected) + " of 100"
        : "Visibility radar, 3D time series, " + M + " scans, current scan " + (m.timestamp || ""));
    }
    function announceAxis() {
      var a = axes[st.kbAxis], s = clamp(num(measurements[st.selected].scores[a.key]), 0, 100);
      announce(a.label + ", " + s + ", " + bandLabel(s) + ((subm[a.key] || []).length ? " — press Enter to open detail" : ""));
    }
    function announceScan() { announce(measurements[st.selected].timestamp + ", average " + avgScore(st.selected)); }
    function orbitBy(dyaw, dpitch) { st.anim = null; st.vel.yaw = 0; st.vel.pitch = 0; st.yaw += dyaw; st.pitch = clamp(st.pitch + dpitch, -1.45, 1.45); renderCanvas(); }
    function zoomBy(f) { st.zoom = clamp(st.zoom * f, 0.4, 3); renderCanvas(); }

    canvas.addEventListener("focus", function () {
      st.focused = true; renderCanvas();
      announce(st.mode === "flat"
        ? "Flat radar, " + measurements[st.selected].timestamp + ". Left and right arrows move between axes; Enter opens detail."
        : "3D time-series radar, " + M + " scans. Arrow keys orbit; Enter opens the current scan.");
    });
    canvas.addEventListener("blur", function () { st.focused = false; renderCanvas(); });
    canvas.addEventListener("keydown", function (e) {
      if (!N || !M) return;
      var k = e.key;
      if (st.mode === "flat") {
        if (k === "ArrowRight" || k === "ArrowLeft") { e.preventDefault(); st.kbAxis = (st.kbAxis + (k === "ArrowRight" ? 1 : N - 1)) % N; renderCanvas(); announceAxis(); }
        else if (k === "ArrowUp" || k === "ArrowDown") { if (M < 2) return; e.preventDefault(); selectIndex(st.selected + (k === "ArrowUp" ? 1 : -1)); announceScan(); }
        else if (k === "Home") { e.preventDefault(); st.kbAxis = 0; renderCanvas(); announceAxis(); }
        else if (k === "End") { e.preventDefault(); st.kbAxis = N - 1; renderCanvas(); announceAxis(); }
        else if (k === "Enter" || k === " " || k === "Spacebar") { if ((subm[axes[st.kbAxis].key] || []).length) { e.preventDefault(); openDrill(st.kbAxis); } }
        else if (k === "Escape") { if (M > 1) { e.preventDefault(); setMode("3d"); announce("3D time series, " + M + " scans"); } }
      } else {
        if (k === "ArrowLeft") { e.preventDefault(); orbitBy(-0.2, 0); }
        else if (k === "ArrowRight") { e.preventDefault(); orbitBy(0.2, 0); }
        else if (k === "ArrowUp") { e.preventDefault(); orbitBy(0, -0.16); }
        else if (k === "ArrowDown") { e.preventDefault(); orbitBy(0, 0.16); }
        else if (k === "+" || k === "=") { e.preventDefault(); zoomBy(1.1); }
        else if (k === "-" || k === "_") { e.preventDefault(); zoomBy(1 / 1.1); }
        else if (k === "PageUp" || k === "PageDown") { e.preventDefault(); selectIndex(st.selected + (k === "PageUp" ? 1 : -1)); announceScan(); }
        else if (k === "Home") { e.preventDefault(); selectIndex(M - 1); announceScan(); }
        else if (k === "End") { e.preventDefault(); selectIndex(0); announceScan(); }
        else if (k === "Enter" || k === " " || k === "Spacebar") { e.preventDefault(); setMode("flat"); announce("Flat view, " + measurements[st.selected].timestamp); }
      }
    });

    function canvasPoint(e) {
      var r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    // nearest tube vertex to the pointer (within tolerance), preferring the node nearest the camera
    function hitNode3d(e) {
      var pt = canvasPoint(e), buf = st.nodes3d || [], best = null, bestZ = -Infinity, TOL = 13;
      for (var k = 0; k < buf.length; k++) {
        var nd = buf[k];
        if (Math.hypot(nd.x - pt.x, nd.y - pt.y) <= TOL && nd.z > bestZ) { best = nd; bestZ = nd.z; }
      }
      return best ? { i: best.i, t: best.t } : null;
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
