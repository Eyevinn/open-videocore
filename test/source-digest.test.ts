// Tests for scripts/source-digest.mjs (issue #827).
//
// The digest is the build identifier that survives a build we do not control:
// it needs no git metadata and no build arguments. For it to be usable as
// build identity it must be (a) stable — the same tree always digests to the
// same value, or a deployment's identifier could not be matched against a
// commit — and (b) sensitive — any change to the shipped source must change it,
// or two different builds would again report the same thing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error - plain ESM script, deliberately dependency-free and
// outside the typechecked `src` rootDir (tsconfig.json "include": ["src"]).
import { sourceDigest, INPUT_PATHS } from '../scripts/source-digest.mjs';

let root: string;

function writeTree(base: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(base, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

const baseTree = {
  'package.json': '{"name":"open-videocore-api","version":"1.5.0"}\n',
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'tsconfig.json': '{"compilerOptions":{}}\n',
  'src/main.ts': 'export const a = 1;\n',
  'src/routes/health.ts': 'export const health = true;\n',
  'public/index.html': '<!doctype html>\n'
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'source-digest-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('sourceDigest (issue #827)', () => {
  it('is stable across runs over an identical tree', () => {
    writeTree(root, baseTree);
    const first = sourceDigest(root);

    const other = mkdtempSync(join(tmpdir(), 'source-digest-'));
    try {
      // Written in a different insertion order, in a different directory: the
      // digest must depend on tree content only.
      writeTree(
        other,
        Object.fromEntries(Object.entries(baseTree).reverse()) as Record<string, string>
      );
      expect(sourceDigest(other)).toBe(first);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('is a short lower-case hex string', () => {
    writeTree(root, baseTree);
    expect(sourceDigest(root)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when shipped source changes', () => {
    writeTree(root, baseTree);
    const before = sourceDigest(root);
    writeTree(root, { 'src/routes/health.ts': 'export const health = false;\n' });
    expect(sourceDigest(root)).not.toBe(before);
  });

  it('changes when a dependency version changes but package.json version does not', () => {
    // Exactly the case the issue describes: package.json still says 1.5.0.
    writeTree(root, baseTree);
    const before = sourceDigest(root);
    writeTree(root, { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n# bumped\n" });
    expect(sourceDigest(root)).not.toBe(before);
  });

  it('changes when a file is renamed but its content is not', () => {
    writeTree(root, baseTree);
    const before = sourceDigest(root);
    rmSync(join(root, 'src/routes/health.ts'));
    writeTree(root, { 'src/routes/status.ts': 'export const health = true;\n' });
    expect(sourceDigest(root)).not.toBe(before);
  });

  it('changes when static assets served from the image change', () => {
    writeTree(root, baseTree);
    const before = sourceDigest(root);
    writeTree(root, { 'public/index.html': '<!doctype html><title>x</title>\n' });
    expect(sourceDigest(root)).not.toBe(before);
  });

  it('ignores files outside the set that goes into the image', () => {
    writeTree(root, baseTree);
    const before = sourceDigest(root);
    writeTree(root, {
      'README.md': '# not shipped\n',
      'docs/architecture/ADR-001-osc-stack.md': 'not shipped\n'
    });
    expect(sourceDigest(root)).toBe(before);
  });

  it('digests a tree missing an optional input rather than throwing', () => {
    // A minimal checkout (or a build context without public/) must still
    // produce an identifier.
    const { 'public/index.html': _omitted, ...withoutPublic } = baseTree;
    writeTree(root, withoutPublic);
    expect(sourceDigest(root)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('covers every path the image is built from', () => {
    // Guard against the input list silently drifting from the Dockerfile's
    // COPY instructions — a shipped path that is not listed would not change
    // the digest, which would reintroduce indistinguishable builds.
    expect(INPUT_PATHS).toEqual([
      'package.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'src',
      'public'
    ]);
  });
});
