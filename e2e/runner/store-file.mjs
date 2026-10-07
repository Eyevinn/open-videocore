import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Result store on a directory: results/by-digest/<digest>.json and results/latest.json. For tests and local use. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function fileStore(dir) {
  // The digest comes off the network (a registry header) and becomes a file name: accept only the exact
  // form, so a hostile value like ../../x can never leave results/by-digest/.
  const file = (digest) => {
    if (!DIGEST.test(String(digest))) throw new Error(`refusing malformed image digest: ${String(digest).slice(0, 80)}`);
    return path.join(dir, 'results', 'by-digest', `${digest}.json`);
  };
  return {
    async get(digest) {
      try { return JSON.parse(await readFile(file(digest), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    },
    async put(digest, record) {
      await mkdir(path.dirname(file(digest)), { recursive: true });
      await writeFile(file(digest), JSON.stringify(record, null, 2));
      await writeFile(path.join(dir, 'results', 'latest.json'), JSON.stringify(record, null, 2));
    },
  };
}
