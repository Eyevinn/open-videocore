// #1110: a secret GLUED to a preceding word character must still be redacted.
//
// These cases are a probe of redactSpawnFailureMessage()
// (src/encore-scaler/spawn-failure.ts), whose output is published on the
// deliberately UNAUTHENTICATED GET /scaler/status (src/routes/scaler.ts), so
// anything that survives a pass here is public.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - redactSpawnFailureMessage(error, secrets) and the REDACTED /
//     SPAWN_FAILURE_MESSAGE_MAX_LENGTH / REDACTION_INPUT_MAX_LENGTH constants —
//     src/encore-scaler/spawn-failure.ts (exported symbols).
//   - The three patterns under test: JWT_PATTERN, AUTH_SCHEME_PATTERN,
//     NETWORK_LOCATION_PATTERN (module-private, exercised through the exported
//     function), same file.

import { describe, expect, it } from 'vitest';
import {
  redactSpawnFailureMessage,
  REDACTION_INPUT_MAX_LENGTH,
  SPAWN_FAILURE_MESSAGE_MAX_LENGTH
} from '../src/encore-scaler/spawn-failure.js';

describe('a secret glued to a preceding word character is still redacted (#1110)', () => {
  const JWT =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

  // A short message, so nothing else in the pipeline (the input clamp, the
  // output budget) can be credited with the redaction.
  it('redacts a JWT glued to a digit', () => {
    const message = redactSpawnFailureMessage(new Error(`auth rejected 6${JWT}`));
    expect(message).not.toContain('eyJhbGci');
    expect(message).not.toContain(JWT.slice(0, 12));
    expect(message).toContain('[redacted]');
    expect(message).toContain('auth rejected');
  });

  it('redacts a JWT glued to a letter, an underscore and a dot', () => {
    for (const prefix of ['x', '_', '.']) {
      const message = redactSpawnFailureMessage(new Error(`id=${prefix}${JWT} denied`));
      expect(message).not.toContain('eyJhbGci');
      expect(message).toContain('denied');
    }
  });

  it('redacts an auth-scheme value when the scheme is glued to a word character', () => {
    const message = redactSpawnFailureMessage(
      new Error('header xBearer abc123DEFghi456xyz rejected')
    );
    expect(message).not.toContain('abc123DEFghi456xyz');
    expect(message).toContain('[redacted]');
    // The operator still learns what failed.
    expect(message).toContain('rejected');
  });

  it('redacts a glued basic/token scheme value too', () => {
    for (const text of [
      'yBasic QWxhZGRpbjpvcGVuc2VzYW1l failed',
      '9token hunter2hunter2hunter2 refused'
    ]) {
      const message = redactSpawnFailureMessage(new Error(text));
      expect(message).not.toContain('QWxhZGRpbjpvcGVuc2VzYW1l');
      expect(message).not.toContain('hunter2hunter2hunter2');
      expect(message).toContain('[redacted]');
    }
  });

  it('redacts an IP:port glued to a word character', () => {
    const message = redactSpawnFailureMessage(new Error('connect ECONNREFUSED x10.42.3.17:6379'));
    expect(message).not.toContain('10.42.3.17');
    expect(message).not.toContain('6379');
    expect(message).toContain('[redacted]');
    // The SHAPE of the failure is the whole point of the record.
    expect(message).toContain('ECONNREFUSED');
  });

  it('redacts an IP glued to an underscore, a longer word and digits', () => {
    const cases = ['_10.42.3.17:6379', 'host10.0.0.1 unreachable', '1234x10.42.3.17 refused'];
    for (const text of cases) {
      const message = redactSpawnFailureMessage(new Error(`connect ECONNREFUSED ${text}`));
      expect(message).not.toContain('10.42.3.17');
      expect(message).not.toContain('10.0.0.1');
      expect(message).toContain('[redacted]');
    }
  });

  it('redacts a hostname glued to a word character', () => {
    const message = redactSpawnFailureMessage(
      new Error('getaddrinfo ENOTFOUND xcache-7f3a.internal.example.net')
    );
    expect(message).not.toContain('cache-7f3a');
    expect(message).not.toContain('internal.example.net');
    expect(message).toContain('ENOTFOUND');
  });

  // The anchors came off to make the cases above work; the diagnostics that
  // merely LOOK like a secret must still survive, or the record stops telling an
  // operator anything.
  it('still keeps the diagnostics that only look like a secret', () => {
    expect(
      redactSpawnFailureMessage(
        new Error('upstream nginx/1.18.0 returned status:504 (e.g. node provisioning)')
      )
    ).toBe('upstream nginx/1.18.0 returned status:504 (e.g. node provisioning)');

    expect(
      redactSpawnFailureMessage(new Error('could not load profiles.yaml referenced by manifest.m3u8'))
    ).toBe('could not load profiles.yaml referenced by manifest.m3u8');

    expect(
      redactSpawnFailureMessage(new Error('secret not found for key profiles and token missing'))
    ).toBe('secret not found for key profiles and token missing');
  });

  // #1110 acceptance criterion: dropping the anchors must not reintroduce the
  // quadratic behaviour #1081 removed. Same shape as the existing timing tests,
  // run against the glued forms.
  it('stays linear on adversarial glued input', () => {
    function time(text: string): number {
      const started = performance.now();
      redactSpawnFailureMessage(new Error(text));
      return performance.now() - started;
    }
    // 'a-' is a valid start for a DNS label, a URL scheme and a field name at
    // every offset; the glued-prefix split adds a per-candidate pass on top.
    const small = time(`x${'a-'.repeat(10_000)}10.42.3.17:6379`);
    const large = time(`x${'a-'.repeat(80_000)}10.42.3.17:6379`);
    expect(large).toBeLessThan(Math.max(small * 12, 200));

    // A long run of JWT openers and scheme words, which now match mid-word.
    expect(time(`x${'eyJ'.repeat(30_000)}`)).toBeLessThan(200);
    expect(time('xBearer '.repeat(20_000))).toBeLessThan(200);
    // An unbroken digit-and-dot run: every offset is a candidate octet.
    expect(time(`host${'1.2.3.4'.repeat(15_000)}`)).toBeLessThan(200);
  });
});

// #1110 finding 3: the 400-character output budget is cut at a token boundary
// too, so the published message no longer ends mid-token.
describe('the output budget is cut at a token boundary (#1110)', () => {
  it('ends the truncated message at a delimiter, not mid-token', () => {
    // Tokens of an awkward length, so a fixed 399-character cut would land
    // inside one of them.
    const full = `${'seven77 '.repeat(60)}tail`;
    const message = redactSpawnFailureMessage(new Error(full));

    expect(message.length).toBeLessThanOrEqual(SPAWN_FAILURE_MESSAGE_MAX_LENGTH);
    expect(message.endsWith('…')).toBe(true);

    // What was published is a PREFIX of the untruncated text, and the character
    // immediately after it in that text is a delimiter — i.e. no token was cut
    // in half. (A fixed-offset cut gives `seve…` here.)
    const body = message.slice(0, -1);
    expect(full.startsWith(body)).toBe(true);
    expect(full[body.length]).toBe(' ');
  });

  it('does not publish a fragment of a long identifier that straddles the budget', () => {
    const identifier = `ident-${'z'.repeat(80)}`;
    const message = redactSpawnFailureMessage(
      new Error(`${'word '.repeat(70)}${identifier} trailing`)
    );
    expect(message.length).toBeLessThanOrEqual(SPAWN_FAILURE_MESSAGE_MAX_LENGTH);
    expect(message).not.toContain('ident-z');
  });

  it('still shows an unbroken run that fills the whole budget', () => {
    // No delimiter-aligned prefix exists, so there would be nothing to publish
    // at all. This cut runs after every redaction pass, so the fragment cannot
    // hold a secret those passes would have caught.
    const message = redactSpawnFailureMessage(new Error(`<${'a'.repeat(3_000)}> trailing`));
    expect(message.startsWith('<aaa')).toBe(true);
    expect(message.length).toBe(SPAWN_FAILURE_MESSAGE_MAX_LENGTH);
  });

  it('never publishes a structural secret that the input clamp dropped', () => {
    // Guard against the output budget being mistaken for the input clamp: the
    // input clamp is the leak barrier and still drops an unbroken 4 KB run.
    const message = redactSpawnFailureMessage(
      new Error('A'.repeat(REDACTION_INPUT_MAX_LENGTH + 500))
    );
    expect(message).not.toContain('AAAAAA');
  });
});
