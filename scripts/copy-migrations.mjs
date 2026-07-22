// tsc does not copy non-TS assets. The migration runner reads .sql from disk at
// runtime (relative to import.meta.dirname), so dist/ needs them alongside the JS.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'src', 'db', 'migrations');
// rootDir is the repo root, so tsc emits src/** to dist/src/**.
const to = join(root, 'dist', 'src', 'db', 'migrations');

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copied migrations -> ${to}`);
