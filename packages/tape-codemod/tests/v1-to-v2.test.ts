/**
 * Fixture-pair tests for the v1-to-v2 transform, via jscodeshift's own
 * applyTransform harness (same API object the real runner passes).
 *
 * applyTransform returns the trimmed transformed source, or '' when the
 * transform reported no change (returned null) — which is exactly what
 * the idempotency assertions rely on.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyTransform } from 'jscodeshift/src/testUtils';
import transform, { parser } from '../src/v1-to-v2';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__testfixtures__',
);

const TRANSFORMING = [
  'basic',
  'no-coalesced',
  'multi-stream',
  'opts-merge',
  'aliased',
  'import-preserve',
] as const;

/** Bail fixtures change only by gaining the TODO marker comment. */
const BAILING = [
  'bail-dynamic-policy',
  'bail-conditional',
  'bail-opts-spread',
  'bail-foreign-stream',
] as const;

const ALL = [...TRANSFORMING, ...BAILING];

function read(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

function run(source: string): string {
  return applyTransform(
    { default: transform, parser },
    {},
    { source, path: 'fixture.tsx' },
    { parser: 'tsx' },
  );
}

describe('v1-to-v2', () => {
  for (const name of ALL) {
    it(`transforms ${name}`, () => {
      const input = read(`${name}.input.tsx`);
      const expected = read(`${name}.output.tsx`).trim();
      expect(run(input)).toBe(expected);
    });
  }

  for (const name of BAILING) {
    it(`${name}: adds the TODO marker and leaves the code otherwise untouched`, () => {
      const input = read(`${name}.input.tsx`);
      const output = run(input);
      expect(output).toContain(
        '// TODO(tape-codemod): manual migration needed —',
      );
      // Removing the marker lines restores the input byte-for-byte:
      // nothing else moved.
      const withoutMarkers = output
        .split('\n')
        .filter((line) => !line.includes('TODO(tape-codemod)'))
        .join('\n');
      expect(withoutMarkers).toBe(input.trim());
      // Every v1 call site is still present.
      const v1Calls = (input.match(/useStream\(|useCoalesced\(/g) ?? []).length;
      expect(
        (output.match(/useStream\(|useCoalesced\(/g) ?? []).length,
      ).toBe(v1Calls);
    });
  }

  it('is idempotent: transforming any fixture output changes nothing', () => {
    for (const name of ALL) {
      const once = read(`${name}.output.tsx`);
      // '' means the transform returned null — no modification at all.
      expect(run(once), `${name} was not idempotent`).toBe('');
    }
  });

  it('ignores files that do not import from tape-react', () => {
    const source = [
      "import { useStream } from 'some-other-lib';",
      'export function X() {',
      "  const s = useStream(1, 'quotes');",
      '  return s;',
      '}',
    ].join('\n');
    expect(run(source)).toBe('');
  });

  it('reuses an existing (aliased) useSubscription import', () => {
    const source = [
      "import { useStream, useSubscription as useSub } from '@lalitheswaran11-stack/tape-react';",
      "import { client } from './client';",
      'export function X() {',
      "  const s = useStream(client, 'quotes');",
      '  return s;',
      '}',
    ].join('\n');
    const output = run(source);
    expect(output).toContain("const s = useSub(client, {");
    expect(output).toContain("useSubscription as useSub");
    expect(output).not.toContain('useStream');
  });
});
