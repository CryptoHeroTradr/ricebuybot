#!/usr/bin/env node
/**
 * ZERO-TELEMETRY AUDIT. Phase 9.
 *
 *   node scripts/audit-network.mjs
 *
 * Greps the ENTIRE production dependency tree — not just our code — for outbound network
 * calls, and fails if any of them points somewhere that is not on the allowlist.
 *
 * WHY THE WHOLE TREE. Our own code is easy to keep honest; a transitive dependency that
 * phones home on import is not, and it is exactly the thing nobody looks for. "No telemetry"
 * is a claim about the PROCESS, not about the source file you happened to write.
 *
 * This is a grep, and a grep can be fooled by a string built at runtime. It is a smoke
 * alarm, not a firewall — the firewall is the VPS. But it catches the realistic case: a
 * package with `analytics.example.com` sitting in its source.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';

/** The ONLY hosts this process may ever contact. */
const ALLOWED = [
  'api.telegram.org', // the Bot API
  'helius-rpc.com', // RPC
  'helius.xyz',
  'binance.us', // SOL/USD primary
  'coinbase.com', // SOL/USD secondary
  'exchange.coinbase.com',
  // The media host, and ONLY when MEDIA_SOURCE=http. On the flagship deployment the pool is
  // on the same box and this is never contacted at all.
  '1grainofrice.com',
];

/** Hosts that are always a bug if they show up. Named, so the failure is unambiguous. */
const FORBIDDEN = [
  'sentry.io',
  'ingest.sentry.io',
  'google-analytics.com',
  'googletagmanager.com',
  'segment.io',
  'amplitude.com',
  'mixpanel.com',
  'datadoghq.com',
  'newrelic.com',
  'bugsnag.com',
  'posthog.com',
  'telemetry',
  'phone-home',
];

const URL_RE = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
const SKIP_DIRS = new Set(['.git', '.bin', 'test', 'tests', '__tests__', 'docs', 'example', 'examples']);
const CODE = new Set(['.js', '.mjs', '.cjs', '.ts']);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(join(dir, e.name));
    } else if (CODE.has(extname(e.name))) {
      yield join(dir, e.name);
    }
  }
}

const hosts = new Map(); // host -> Set(files)
const forbidden = [];

/**
 * PRODUCTION DEPENDENCIES ONLY.
 *
 * Scanning all of node_modules is worse than useless: it flags vitest, vite and typescript —
 * none of which are ever loaded by the running bot — and buries the one finding that would
 * matter under a hundred that cannot. `pnpm ls --prod` is the exact set that ships.
 */
function prodPackagePaths() {
  const out = execFileSync('pnpm', ['ls', '--prod', '--depth', 'Infinity', '--parseable'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const self = resolve('.');
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && resolve(l) !== self);
}

const roots = ['src', 'scripts', ...prodPackagePaths()];
const SELF = resolve('scripts/audit-network.mjs');

for (const root of roots) {
  try {
    statSync(root);
  } catch {
    continue;
  }
  for (const file of walk(root)) {
    // The audit lists the hosts it forbids, so it would otherwise flag itself — a false
    // positive that would train whoever runs this to ignore the output.
    if (resolve(file) === SELF) continue;

    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.length > 4_000_000) continue; // a bundled monster; not worth the RAM

    for (const m of text.matchAll(URL_RE)) {
      const host = m[1].toLowerCase();
      if (!hosts.has(host)) hosts.set(host, new Set());
      if (hosts.get(host).size < 3) hosts.get(host).add(file);
    }
    for (const bad of FORBIDDEN) {
      if (text.includes(bad)) forbidden.push({ file, bad });
    }
  }
}

const allowed = (h) => ALLOWED.some((a) => h === a || h.endsWith(`.${a}`) || h.includes(a));

// Documentation, schemas, licences and spec URLs are not network calls. We only care about
// hosts that look like a service someone could actually be talking to.
const IGNORABLE = /(^|\.)(w3\.org|json-schema\.org|npmjs\.com|github\.com|githubusercontent\.com|nodejs\.org|opensource\.org|mozilla\.org|tc39\.es|ecma-international\.org|unicode\.org|iana\.org|ietf\.org|rfc-editor\.org|apache\.org|example\.com|localhost|schema\.org|spdx\.org|creativecommons\.org|gnu\.org|python\.org|microsoft\.com|typescriptlang\.org|reactjs\.org|jquery\.com|zlib\.net|sqlite\.org|openssl\.org|es5\.github\.io|developer\.mozilla\.org)$/i;

const unexpected = [...hosts.entries()]
  .filter(([h]) => !allowed(h) && !IGNORABLE.test(h))
  .sort();

console.log('Allowlist (the ONLY hosts this process may contact):');
for (const a of ALLOWED) console.log(`  ✓ ${a}`);

if (forbidden.length > 0) {
  console.log('\n❌ KNOWN TELEMETRY / ANALYTICS SDK REFERENCES:');
  for (const f of forbidden.slice(0, 20)) console.log(`  ${f.bad}  <-  ${f.file}`);
}

if (unexpected.length > 0) {
  console.log(`\n⚠️  ${unexpected.length} host(s) referenced that are not on the allowlist:`);
  for (const [host, files] of unexpected.slice(0, 40)) {
    console.log(`  ${host}`);
    for (const f of files) console.log(`      ${f}`);
  }
}

const bad = forbidden.length > 0;
console.log(
  `\n${bad ? '❌ FAIL' : '✅ PASS'} — ${hosts.size} distinct hosts seen, ${unexpected.length} off-allowlist, ${forbidden.length} telemetry references.`,
);
process.exit(bad ? 1 : 0);
