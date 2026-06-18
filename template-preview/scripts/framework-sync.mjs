#!/usr/bin/env node
/*
 * framework-sync.mjs — pull the latest framework/ (radar + builder + gates) from the
 * canonical template into THIS client repo, so improvements propagate. The framework/
 * layer is the single source of truth; client-specific data/config is never touched.
 *
 *   node scripts/framework-sync.mjs --from <path-to-template-repo-checkout>
 *
 * Typical use (delegated): clone/pull the template repo somewhere, point --from at it.
 * After syncing, re-run the gates and commit the bumped framework/.
 */
import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--from");
const FROM = i >= 0 ? process.argv[i + 1] : null;
if (!FROM) { console.error("Usage: node scripts/framework-sync.mjs --from <template-repo-path>"); process.exit(1); }

const src = resolve(FROM, "framework"), dst = resolve(ROOT, "framework");
if (!existsSync(src)) { console.error(`no framework/ at ${src}`); process.exit(1); }
const ver = d => { const p = join(d, "VERSION"); return existsSync(p) ? readFileSync(p, "utf8").trim() : "?"; };
const before = ver(dst);
function copyDir(s, d) { mkdirSync(d, { recursive: true }); for (const e of readdirSync(s)) { const sp = join(s, e), dp = join(d, e); statSync(sp).isDirectory() ? copyDir(sp, dp) : copyFileSync(sp, dp); } }
copyDir(src, dst);
console.log(`✓ framework synced ${before} → ${ver(dst)} (radar + builder + gates).`);
console.log(`  next: re-run the gates, eyeball the report, commit the framework bump.`);
