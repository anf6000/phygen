// ─────────────────────────────────────────────────────────────────────────────
// validate-package.mjs — validate one artwork package before it can run.
//
//   node tools/validate-package.mjs [--package <dir>]
//
// The checks live in the shared runtime module, so the controller applies the
// same rules to an imported package. Exit code 0 means the package passed.
// Exit code 1 means the package must not run.
// ─────────────────────────────────────────────────────────────────────────────
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPackage } from '../../runtime/node/package-checks.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_PACKAGE = resolve(HERE, '..');

function parseArgs(argv) {
  const options = { packageDir: DEFAULT_PACKAGE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') {
      const value = argv[i + 1];
      if (!value) throw new Error('--package needs a directory');
      options.packageDir = resolve(value);
      i++;
    }
  }
  return options;
}

async function main() {
  const { packageDir } = parseArgs(process.argv.slice(2));
    // This tool runs inside the package the author owns, so it may import the entry.
  const result = await checkPackage({ packageDir, verifyEntry: true });

  console.log(`package: ${packageDir}`);
  for (const note of result.notes) console.log(`  ok    ${note}`);
  for (const problem of result.problems) console.log(`  FAIL  ${problem}`);
  if (result.packageHash) console.log(`  ok    package hash ${result.packageHash}`);

  if (result.ok) {
    console.log('package validation passed');
  } else {
    console.log(`package validation failed: ${result.problems.length} problem(s)`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`package validation failed: ${error.message}`);
  process.exitCode = 1;
});
