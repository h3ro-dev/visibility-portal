#!/usr/bin/env node
/*
 * bootstrap.mjs — adjust a freshly-instantiated client repo for one client.
 * Run once, right after creating the repo from the template.
 *
 *   node scripts/bootstrap.mjs <slug> "<Client Name>" <domain> [run-date]
 *
 * It writes CLIENT.json and stamps the starter timeline's title/client so the
 * page renders with the client's name. It does NOT touch the framework/ layer
 * (that stays in sync with the template — see framework-sync.mjs).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [slug, name, domain, runDate] = process.argv.slice(2);
if (!slug || !name || !domain) {
  console.error('Usage: node scripts/bootstrap.mjs <slug> "<Client Name>" <domain> [run-date]');
  process.exit(1);
}
writeFileSync(resolve(ROOT, "CLIENT.json"), JSON.stringify({ slug, name, domain, runDate: runDate || "" }, null, 2) + "\n");
try {
  const tlPath = resolve(ROOT, "data/timeline.json");
  const tl = JSON.parse(readFileSync(tlPath, "utf8"));
  tl.title = `${name} — visibility over time`;
  tl.client = { slug, name };
  writeFileSync(tlPath, JSON.stringify(tl, null, 2) + "\n");
} catch (e) { console.warn("! could not stamp data/timeline.json:", e.message); }
console.log(`✓ bootstrapped for ${name}  (slug=${slug} · ${domain})`);
console.log(`  next: replace data/timeline.json with this client's real run (framework/build-timeline.mjs), run the gates, commit, enable Pages.`);
