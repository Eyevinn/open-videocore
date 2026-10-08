/** A commit SHA is the result key. It reaches us from the GitHub API and the instance's /health, so validate it
 *  before it becomes a file name or an object key. */
export const COMMIT = /^[0-9a-f]{40}$/;
export function assertCommit(c) {
  if (!COMMIT.test(String(c))) throw new Error(`refusing malformed commit sha: ${String(c).slice(0, 80)}`);
  return c;
}
