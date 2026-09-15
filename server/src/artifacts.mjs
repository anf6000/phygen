// ─────────────────────────────────────────────────────────────────────────────
// artifacts.mjs — where immutable files live, and how the controller reaches
// them.
//
//   <repo>/snapshots/<packageId>/<hash>/files/…   version source snapshots
//   <data>/captures/<versionId>/…                 captured images
//   <packageDir>/node_modules/…                   approved pinned dependencies
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { assertManifest } from '../../runtime/manifest.js';

export function createArtifacts({ store, config }) {
  const runtimeDir = join(config.repoRoot, 'runtime');

  return {
    runtimeDir,

    /** The live origin URL for one version. Capture and playback use it. */
    liveUrlFor(versionId) {
      return `http://${config.host}:${config.livePort}/v/${versionId}/`;
    },

    /** The version snapshot root that holds index.html, src/, and config.json. */
    snapshotDirFor(version) {
      return join(version.snapshotPath, 'files');
    },

    /** Approved pinned dependencies of the package. Read-only. */
    nodeModulesDir(packageDir) {
      return join(packageDir, 'node_modules');
    },

    /** Manifest, schema, and baseline of one artwork, read once per process. */
    artworkContext(artwork) {
      const packageDir = resolve(config.repoRoot, artwork.packagePath);
      const manifest = assertManifest(JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')));
      const schema = JSON.parse(readFileSync(join(packageDir, manifest.configuration.schema), 'utf8'));
      const baseline = JSON.parse(readFileSync(join(packageDir, manifest.configuration.baseline), 'utf8'));
      return {
        artwork,
        packageDir,
        manifest,
        schema,
        baseline,
        relativePackageDir: relative(config.repoRoot, packageDir),
      };
    },
  };
}

/** True when `target` stays inside `root`. */
export function isInside(root, target) {
  const inside = relative(resolve(root), resolve(target));
  return inside.length > 0 && !inside.startsWith('..') && !/^[A-Za-z]:/.test(inside);
}
