/* Shared review chrome — injects a top nav + a "How to read the radar" legend onto
 * every Pages page, so a first-time reviewer can navigate the pieces and read the
 * radar. Dependency-free; safe on the WebGL portal and the canvas skill/template. */
(function () {
  "use strict";
  var BASE = "/visibility-portal";
  var PAGES = [
    { label: "Live report", href: BASE + "/" },
    { label: "Skill demo", href: BASE + "/skill-demo/" },
    { label: "Template", href: BASE + "/template-preview/" },
    { label: "Doctrine", href: "https://h3ro-dev.github.io/new-reward-seo-skills-os/", ext: true }
  ];
  var here = location.pathname.replace(/index\.html$/, "").replace(/\/+$/, "/");

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---- top nav ----
  var nav = document.createElement("nav");
  nav.className = "sn-nav";
  var links = PAGES.map(function (p) {
    var path = p.ext ? null : p.href.replace(/index\.html$/, "").replace(/\/+$/, "/");
    var active = path && (here === path);
    return '<a href="' + esc(p.href) + '"' + (p.ext ? ' target="_blank" rel="noopener" class="sn-ext"' : (active ? ' class="sn-active" aria-current="page"' : "")) + ">" + esc(p.label) + "</a>";
  }).join("");
  nav.innerHTML =
    '<div class="sn-brand"><b>Visibility Scorecard</b><span>12-axis SEO/GEO/GDO visibility, scored over time</span></div>' +
    '<div class="sn-links">' + links + '<button class="sn-howto" type="button" aria-haspopup="dialog">How to read</button></div>';
  document.body.insertBefore(nav, document.body.firstChild);

  // ---- "how to read the radar" legend ----
  var sw = function (c) { return '<span class="sn-sw" style="background:' + c + '"></span>'; };
  var legend = document.createElement("div");
  legend.className = "sn-legend"; legend.hidden = true;
  legend.setAttribute("role", "dialog"); legend.setAttribute("aria-modal", "true"); legend.setAttribute("aria-label", "How to read the radar");
  legend.innerHTML =
    '<div class="sn-legend-card" role="document">' +
    '<button class="sn-legend-x" type="button" aria-label="Close">×</button>' +
    "<h2>How to read this</h2>" +
    '<p class="sn-sub">A 12-axis SEO/GEO/GDO visibility scorecard, scored 0–100 per axis and tracked over time.</p>' +
    "<dl>" +
    "<div><dt>The shape</dt><dd>Each spoke is one of the 12 axes; distance from the centre is its score (0 centre → 100 edge). The filled shape is the current scan.</dd></div>" +
    "<div><dt>Colour = health" + '<span class="sn-swatches">' + sw("#2e6f40") + sw("#b87514") + sw("#9b2424") + "</span></dt><dd>Green ≥ 75 strong · amber 60–74 watch · red &lt; 60 risk. Same scale everywhere (dots, bars, rings).</dd></div>" +
    "<div><dt>Groups" + '<span class="sn-swatches">' + sw("#44598a") + sw("#7a566f") + sw("#2f7d86") + "</span></dt><dd>The 12 axes are grouped into Foundation · Credibility · Demand &amp; Conversion (cool colours, kept separate from the health scale).</dd></div>" +
    "<div><dt>Confidence dot</dt><dd>On the ranked list — how verified a score is (green verified · amber partial · red unverified).</dd></div>" +
    "<div><dt>Click any axis</dt><dd>Opens its drill-down: the submetrics behind it, where each is measured from, and its trend over time.</dd></div>" +
    "<div><dt>Drag to orbit</dt><dd>Tilts the flat radar into a 3D tube — every past scan stacked along depth = time, so you see the shape evolve.</dd></div>" +
    "<div><dt>“Where you stand”</dt><dd>The ranked bar list gives the exact order the radar's angles can't; weakest/blocked axes are flagged.</dd></div>" +
    "</dl></div>";
  document.body.appendChild(legend);

  var lastFocus = null;
  function open() { lastFocus = document.activeElement; legend.hidden = false; var x = legend.querySelector(".sn-legend-x"); if (x) x.focus(); }
  function close() { if (legend.hidden) return; legend.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  nav.querySelector(".sn-howto").addEventListener("click", open);
  legend.addEventListener("click", function (e) { if (e.target === legend || e.target.closest(".sn-legend-x")) close(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !legend.hidden) close(); });
  legend.addEventListener("keydown", function (e) {   // focus trap
    if (e.key !== "Tab") return;
    var card = legend.querySelector(".sn-legend-card"); if (!card) return;
    var f = [].slice.call(card.querySelectorAll('button,a[href],[tabindex]:not([tabindex="-1"])')).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
})();
