#!/usr/bin/env node
/**
 * tape-codemod — thin CLI over jscodeshift for tape-react migrations.
 *
 *   tape-codemod v1-to-v2 <paths...> [--dry]
 *
 * Locates the jscodeshift binary and the built transform
 * (dist/v1-to-v2.cjs) and spawns jscodeshift with --parser=tsx
 * --extensions=ts,tsx, forwarding --dry.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const USAGE = 'Usage: tape-codemod v1-to-v2 <paths...> [--dry]';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [subcommand, ...rest] = process.argv.slice(2);

if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
  fail(USAGE);
}
if (subcommand !== 'v1-to-v2') {
  fail(`tape-codemod: unknown subcommand '${subcommand}'\n${USAGE}`);
}

const dry = rest.includes('--dry');
const paths = rest.filter((arg) => arg !== '--dry');
if (paths.length === 0) {
  fail(`tape-codemod: no paths given\n${USAGE}`);
}

const transformPath = path.join(HERE, '..', 'dist', 'v1-to-v2.cjs');
if (!existsSync(transformPath)) {
  fail(
    `tape-codemod: transform not built (missing ${transformPath}). ` +
      'Run the package build first.',
  );
}

let jscodeshiftBin;
try {
  const pkgPath = require.resolve('jscodeshift/package.json');
  const pkg = require('jscodeshift/package.json');
  const bin =
    typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.jscodeshift;
  if (!bin) throw new Error('jscodeshift package.json has no bin entry');
  jscodeshiftBin = path.join(path.dirname(pkgPath), bin);
} catch (err) {
  fail(`tape-codemod: cannot locate jscodeshift (${err.message})`);
}

const args = [
  jscodeshiftBin,
  '-t',
  transformPath,
  '--parser=tsx',
  '--extensions=ts,tsx',
  ...(dry ? ['--dry'] : []),
  ...paths,
];

const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) fail(`tape-codemod: ${result.error.message}`);
process.exit(result.status ?? 1);
