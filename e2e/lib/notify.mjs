// Slack alert for a failing e2e verdict. Posts with chat.postMessage using a bot token (E2E_SLACK_BOT_TOKEN) to a channel
// (E2E_SLACK_CHANNEL, default #internal-dev-mediaconvert); with no token configured it does nothing. A failed post is reported to the caller, never thrown: the verdict is already stored
// and the cycle must still exit 0 (see runner/cli.mjs).
import { redact } from './redact.mjs';

const ALERT_ON = new Set(['red', 'infra-error']);

/** Which records deserve a message. red is final per commit, so it alerts once. infra-error is retried every cycle,
 *  so only the first one for a commit alerts; stale is routine (a merge landed mid-run) and stays silent. */
export function shouldAlert(record, prior) {
  if (!ALERT_ON.has(record.status)) return false;
  if (record.status === 'infra-error' && prior?.status === 'infra-error') return false;
  return true;
}

export function formatAlert(record) {
  const short = String(record.commit).slice(0, 7);
  const lines = [`:rotating_light: open-videocore e2e *${record.status}* for commit \`${short}\``];
  const failed = (record.cases ?? []).filter((c) => c.status && c.status !== 'pass' && c.status !== 'skipped');
  for (const c of failed) lines.push(`• \`${c.id ?? c.name}\` ${c.status}${c.detail ? `: ${String(c.detail).slice(0, 200)}` : ''}`);
  if (record.detail) lines.push(String(record.detail).slice(0, 300));
  lines.push(`Verdict: results/by-commit/${record.commit}.json`);
  return lines.join('\n');
}

export const DEFAULT_CHANNEL = 'C0C4GLN8GAC'; // #internal-dev-mediaconvert

/** @returns {(record: any, prior: any) => Promise<void>} */
export function slackNotifier({ token, channel = DEFAULT_CHANNEL, secrets = [], fetchImpl = fetch }) {
  return async (record, prior) => {
    if (!token || !shouldAlert(record, prior)) return;
    const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text: redact(formatAlert(record), secrets) }),
    });
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    if (!res.ok || !body.ok) throw new Error(`Slack chat.postMessage failed: ${res.ok ? body.error ?? 'unknown' : `HTTP ${res.status}`}`);
  };
}
