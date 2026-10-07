import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Result store on a directory: results/by-commit/<commit>.json and results/latest.json. For tests and local use. */
import { assertCommit } from '../lib/commit.mjs';

export function fileStore(dir) {
  // The commit comes off the network (the GitHub API) and becomes a file name: accept only the exact
  // form, so a hostile value like ../../x can never leave results/by-commit/.
  const file = (commit) => path.join(dir, 'results', 'by-commit', `${assertCommit(commit)}.json`);
  return {
    async get(commit) {
      try { return JSON.parse(await readFile(file(commit), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    },
    async put(commit, record) {
      await mkdir(path.dirname(file(commit)), { recursive: true });
      await writeFile(file(commit), JSON.stringify(record, null, 2));
      await writeFile(path.join(dir, 'results', 'latest.json'), JSON.stringify(record, null, 2));
    },
  };
}
