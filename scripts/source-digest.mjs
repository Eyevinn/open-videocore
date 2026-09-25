#!/usr/bin/env node
// Deterministic digest of the source tree an image is built from (issue #827).
//
// Why this exists: build identity has to be injected at image build time,
// because the container has no `.git`. The image build, however, is not always
// ours to parameterise — the platform builds the image from the repository
// fork, and `git describe` / `--build-arg` are not guaranteed to be available
// there. This digest is the identifier that needs neither: it is computed from
// the files that go into the image, using only Node, which the build image has
// by definition.
//
// Two properties make it useful as a build identifier:
//   1. It differs whenever the source differs, so two builds carrying the same
//      package.json version are distinguishable.
//   2. It is reproducible from a checkout — running this script against the
//      tree of a candidate commit yields the same value — so a deployment's
//      digest can be mapped back to the exact commit it was built from.
//      scripts/find-build-commit.sh automates that search.
//
// Usage:
//   node scripts/source-digest.mjs [root]      # defaults to the repo root
//
// Determinism requirements, all deliberate:
//   - inputs are a fixed, explicitly listed set of paths (INPUT_PATHS);
//   - files are visited in byte-order of their repo-relative path;
//   - each file contributes its path AND its bytes, so a rename changes the
//     digest;
//   - nothing time-, environment- or filesystem-order-dependent is hashed.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exactly the paths that end up in the runtime image (see Dockerfile: the
// build stage compiles src/ with tsconfig.json against the dependency set
// pinned by package.json + pnpm-lock.yaml, and public/ is copied in as-is).
// Keep this list in step with the Dockerfile's COPY instructions — a file that
// reaches the image but is not listed here would not change the digest.
export const INPUT_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'src',
  'public'
];

// Length of the emitted digest. 16 hex chars (64 bits) is short enough to read
// out over a support call and paste into an issue, and far beyond what an
// accidental collision across a project's commit history needs.
const DIGEST_CHARS = 16;

function collectFiles(root, rel, out) {
  const abs = join(root, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    // A listed path may legitimately be absent (e.g. public/ in a minimal
    // checkout). Absence is itself stable input: skip it.
    return;
  }
  if (st.isFile()) {
    out.push(rel);
    return;
  }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(abs)) {
    collectFiles(root, join(rel, entry), out);
  }
}

/**
 * Compute the source digest of the tree rooted at `root`.
 *
 * @param {string} root Absolute path to a repository checkout.
 * @returns {string} Lower-case hex digest, DIGEST_CHARS long.
 */
export function sourceDigest(root) {
  /** @type {string[]} */
  const files = [];
  for (const p of INPUT_PATHS) collectFiles(root, p, files);

  // Normalise to forward slashes so the digest is identical on any platform,
  // then sort by byte order for a stable visit sequence.
  const normalised = files
    .map((p) => p.split(sep).join('/'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const hash = createHash('sha256');
  for (const rel of normalised) {
    const bytes = readFileSync(join(root, rel.split('/').join(sep)));
    // Path and length are folded in alongside the content so that moving or
    // truncating a file cannot leave the digest unchanged.
    hash.update(rel);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, DIGEST_CHARS);
}

// CLI entry point. Guarded so the module can be imported by tests.
const invokedDirectly =
  process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '';
if (invokedDirectly) {
  const root = process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '..');
  process.stdout.write(`${sourceDigest(root)}\n`);
}
