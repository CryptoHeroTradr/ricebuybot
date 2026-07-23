import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the verify-deploy.sh version check.
 *
 * The migration FILES are zero-padded (`013_dca_schedules.sql`) so the parsed value is "013",
 * while `schema_migrations` stores the integer 13. The first cut compared them raw, and BOTH ways
 * bash compares bit a GOOD deploy:
 *   - "013" == "13"  is false as a string        -> the self-check went red
 *   - "013" -ge "13" reads "013" as OCTAL (= 11)  -> EXPECT_MIGRATION went red
 * It cried wolf on a fine Phase-13 deploy — the same class of failure as a vacuously green test,
 * pointed the other way: a check that trains the operator to skim past red is worse than no check.
 *
 * The fix normalizes every side with `10#N` before comparing. This file pins that behaviour AND
 * the structure of the script, so a revert to a bare string/octal compare fails CI.
 */

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'verify-deploy.sh');
const src = readFileSync(SCRIPT, 'utf8');

/** Run one bash `[[ ]]` test; true iff it succeeds. Exercises the REAL shell, not a JS mock of it. */
function bash(expr: string): boolean {
  try {
    execFileSync('bash', ['-c', `if ${expr}; then exit 0; else exit 1; fi`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Evaluate the version check EXACTLY as verify-deploy.sh does — same `10#` normalization, same
 * `-eq`/`-ge` operators — for raw (possibly zero-padded) dist/db/expect strings.
 */
function versionCheck(distRaw: string, dbRaw: string, expect_?: string): { self: string; intent: string } {
  const snippet = `
    d=$((10#$1)); b=$((10#$2)); e="$3"
    [[ "$b" -eq "$d" ]] && s=PASS || s=FAIL
    if [[ -n "$e" ]]; then n=$((10#$e)); { [[ "$d" -ge "$n" ]] && [[ "$b" -ge "$n" ]]; } && i=PASS || i=FAIL; else i=NA; fi
    echo "$s $i"
  `;
  const out = execFileSync('bash', ['-c', snippet, 'bash', distRaw, dbRaw, expect_ ?? ''], { encoding: 'utf8' }).trim();
  const [self, intent] = out.split(' ');
  return { self: self!, intent: intent! };
}

describe('verify-deploy.sh version check: zero-padding must not cry wolf', () => {
  // THE BUG, as a negative control: prove the raw comparisons really do fail on the padded good
  // case, so this test cannot pass vacuously if someone thinks "013 vs 13, obviously equal".
  it('negative control: RAW comparison fails on a good padded deploy (why the fix is needed)', () => {
    expect(bash(`[[ "013" == "13" ]]`)).toBe(false); // string compare: same number, not equal
    expect(bash(`[[ "013" -ge "13" ]]`)).toBe(false); // arithmetic: "013" is OCTAL 11, 11 >= 13 is false
  });

  it('THE REGRESSION CASE: padded dist "013" vs db "13" — self-check and intent both PASS', () => {
    const r = versionCheck('013', '13', '13');
    expect(r.self).toBe('PASS');
    expect(r.intent).toBe('PASS');
  });

  it('a zero-padded EXPECT_MIGRATION ("013") means the same as "13"', () => {
    expect(versionCheck('013', '13', '013')).toEqual({ self: 'PASS', intent: 'PASS' });
  });

  // The three scenarios that must keep behaving after the fix.
  it('good deploy (13/13, expect 13) passes both', () => {
    expect(versionCheck('13', '13', '13')).toEqual({ self: 'PASS', intent: 'PASS' });
  });

  it('stale deploy (11/11, expect 13): self passes (they agree, old), intent FAILS (caught)', () => {
    expect(versionCheck('011', '11', '13')).toEqual({ self: 'PASS', intent: 'FAIL' });
  });

  it('half-deploy (13/11): self-check FAILS — code shipped, DB did not migrate', () => {
    expect(versionCheck('013', '11').self).toBe('FAIL');
  });
});

describe('verify-deploy.sh keeps its normalized, integer-typed comparisons', () => {
  // Structural guards: catch a revert in the SCRIPT FILE, not just in the pattern above.
  it('normalizes all three values with 10# base-10 casts', () => {
    expect(src).toMatch(/DIST_MAX=\$\(\(10#\$DIST_RAW\)\)/);
    expect(src).toMatch(/DB_MAX=\$\(\(10#\$DB_RAW\)\)/);
    expect(src).toMatch(/10#\$EXPECT_MIGRATION/);
  });

  it('uses an integer -eq for the self-check, never a string ==', () => {
    expect(src).toMatch(/"\$DB_MAX" -eq "\$DIST_MAX"/);
    expect(src).not.toMatch(/"\$DB_MAX" == "\$DIST_MAX"/); // the original bug — must not come back
  });
});
