// ─────────────────────────────────────────────────────────────────────────────
// snapshot.mjs — store one immutable source snapshot of an artwork package.
//
//   node tools/snapshot.mjs [--package <dir>] [--out <dir>]
//
// The snapshot records the hash of every package file and copies the files
// under a directory named after the package hash. A snapshot is written once:
// an existing snapshot is never overwritten.
//
// The default output directory sits NEXT TO the package, never inside it, so an
// author session cannot change or delete a recorded snapshot.
//
// The copy lands in a temporary directory first, then moves to its final name,
// so an interrupted run leaves no half-written snapshot.
// ─────────────────────────────────────────────────────────────────────────────
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertContractVersion } from '../../runtime/contract.js';
import { assertManifest } from '../../runtime/manifest.js';
import { hashPackageFiles, snapshotMarker, walkPackage } from '../../runtime/node/package-checks.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_PACKAGE = resolve(HERE, '..');

const SNAPSHOT_VERSION = 1;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const options = { packageDir: DEFAULT_PACKAGE, outDir: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package') {
      options.packageDir = resolve(argv[++i] ?? '');
    } else if (argv[i] === '--out') {
      options.outDir = resolve(argv[++i] ?? '');
    }
  }
  options.outDir = options.outDir ?? join(options.packageDir, '..', 'snapshots');
  return options;
}

async function main() {
  const { packageDir, outDir } = parseArgs(process.argv.slice(2));
  const manifest = assertManifest(JSON.parse(await readFile(join(packageDir, 'manifest.json'), 'utf8')));
  assertContractVersion(manifest.contractVersion, 'manifest.json');

  const walked = (await walkPackage(packageDir)).filter((file) => !file.symlink);
  const { files, packageHash } = await hashPackageFiles(walked);
  const target = join(outDir, manifest.id, packageHash);
  const marker = join(target, 'snapshot.json');

  if (await exists(marker)) {
    console.log(`snapshot already recorded: ${target}`);
    console.log('an existing snapshot is never overwritten');
    return;
  }

  const working = join(outDir, manifest.id, `.pending-${packageHash}-${process.pid}`);
  await rm(working, { recursive: true, force: true });
  await mkdir(working, { recursive: true });

  for (const file of walked) {
    const destination = join(working, 'files', file.rel);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file.full, destination);
  }

  await mkdir(dirname(working), { recursive: true });
  // the marker is written last: its presence proves the snapshot is complete
  await writeFile(
    join(working, 'snapshot.json'),
    snapshotMarker({ artworkId: manifest.id, contractVersion: manifest.contractVersion, packageHash, files }),
    { encoding: 'utf8', flag: 'wx' },
  );

  if (await exists(target)) {
    await rm(working, { recursive: true, force: true });
    console.log(`snapshot directory exists without a marker, and was not replaced: ${target}`);
    process.exitCode = 1;
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await rename(working, target);
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(`snapshot recorded: ${target}`);
  console.log(`${files.length} file(s), ${bytes} bytes, package hash ${packageHash}`);
}

main().catch((error) => {
  console.error(`snapshot failed: ${error.message}`);
  process.exitCode = 1;
});
