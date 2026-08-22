// Measurement-based verification of the loudness-normalisation profile (issue #386).
//
// Issue #386 is explicit: the loudness feature is only honestly closed when a
// MEASUREMENT — not the mere presence of the `loudnorm` filter string — proves
// the normalised output lands within a stated tolerance of the requested target,
// and that already-compliant source is not degraded. That is a distinct QA
// deliverable from the profile itself (#385).
//
// STATUS IN THIS ENVIRONMENT: DEFERRED, not satisfied.
//   The measured-tolerance acceptance requires a measurement backend: either a
//   local `ffmpeg` binary (to synthesize a source, apply the profile's exact
//   filter, and re-measure integrated loudness via `ebur128`) or a provisioned
//   Encore instance (to run the real transcode and read the measurement back).
//   In the automation environment NEITHER exists — `ffmpeg -version` is absent
//   and 0 Encore instances are provisioned for this workspace (verified in #383,
//   see docs/architecture/encore-audioencode-loudnorm-contract.md "Live
//   verification"). We therefore GATE the measurement cases on ffmpeg
//   availability and mark them SKIPPED-with-reason here rather than fabricate a
//   measured pass. See OSC friction log:
//   docs/osc-feedback/incoming-loudnorm-measurement-no-backend.md.
//
// WHAT STILL RUNS DETERMINISTICALLY (no ffmpeg): the "profileParams honoured"
// invariant — that the filter string derived from the profile carries the
// requested `I=<target>` for each parametrised target — is a pure string/param
// assertion and ALWAYS runs, giving the harness real executed coverage of the
// parametrised path even without a measurement backend.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - src/services/builtin-profiles.ts:71 — LOUDNORM_FILTER =
//       `loudnorm=I=#{profileParams['targetI']?:-23}:TP=-1:LRA=7`
//     i.e. the integrated-loudness target rides the SpEL expression
//     `#{profileParams['targetI']?:-23}`; TP=-1 (true-peak ceiling) and LRA=7 are
//     the fixed EBU R128 companions.
//   - src/services/builtin-profiles.ts:42/53 — LOUDNORM_TARGET_PARAM='targetI',
//     LOUDNORM_DEFAULT_TARGET_LUFS=-23.
//   - src/pipeline/profile-params.ts:43-55 — declaredProfileParamKeys() extracts
//     `targetI` from exactly the `profileParams['<key>']` SpEL shape, so the
//     target key is the caller-settable channel; we substitute it here the way
//     Encore's SpEL evaluation would (property value or the `?:` default).
//   - docs/architecture/encore-audioencode-loudnorm-contract.md (#383) — the
//     filter string reaches ffmpeg VERBATIM as one element of
//     AudioEncode.filters; so a faithful local measurement needs ONLY ffmpeg
//     applying that same string. That doc's "Live verification" section records
//     0 Encore instances provisioned (the reason the live path is deferred).

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOUDNORM_FILTER,
  LOUDNORM_TARGET_PARAM,
  LOUDNORM_DEFAULT_TARGET_LUFS
} from '../src/services/builtin-profiles.js';

// ---------------------------------------------------------------------------
// Stated acceptance parameters (issue #386).
// ---------------------------------------------------------------------------

// Integrated-loudness tolerance. ±1.0 LUFS is a conventional, defensible band
// for single-pass DYNAMIC loudnorm: the one-pass algorithm converges to the
// target but is not bit-exact (a two-pass measure-then-apply flow — ADR-013
// Option B, deferred — would tighten this). The assertion below requires
// |measured - target| <= TOLERANCE_LUFS.
const TOLERANCE_LUFS = 1.0;

// True-peak ceiling the profile requests (TP=-1 dBTP, fixed in LOUDNORM_FILTER).
// "Not degraded / no clipping" is verified as measured true-peak <= this ceiling
// plus a small measurement slack.
const TRUE_PEAK_CEILING_DBTP = -1;
const TRUE_PEAK_SLACK_DBTP = 0.5;

// The two targets exercised, proving profileParams['targetI'] is honoured:
//   -23 LUFS — EBU R128 / broadcast integrated-loudness target (the profile
//              default).
//   -16 LUFS — a common streaming integrated-loudness level, supplied the way a
//              caller would via profileParams.targetI.
const BROADCAST_TARGET_LUFS = -23;
const STREAMING_TARGET_LUFS = -16;
const PARAMETRISED_TARGETS = [BROADCAST_TARGET_LUFS, STREAMING_TARGET_LUFS] as const;

// ---------------------------------------------------------------------------
// Derive the concrete filter string from the profile (never hardcode a divergent
// copy — the test must track the profile). We take LOUDNORM_FILTER, which holds
// the SpEL expression `#{profileParams['targetI']?:-23}` in place of the `I=`
// value, and substitute it with a concrete target exactly as Encore's SpEL
// evaluation would: the caller's profileParams['targetI'] value if supplied,
// else the `?:` default. This yields the SAME filter string ffmpeg receives
// verbatim (contract #383).
// ---------------------------------------------------------------------------

// Matches the SpEL expression carrying the loudnorm target inside LOUDNORM_FILTER,
// e.g. `#{profileParams['targetI']?:-23}`. Captures the `?:` default so we can
// assert the profile's default matches LOUDNORM_DEFAULT_TARGET_LUFS.
const LOUDNORM_TARGET_SPEL = new RegExp(
  `#\\{\\s*profileParams\\[\\s*'${LOUDNORM_TARGET_PARAM}'\\s*\\]\\s*\\?:\\s*(-?\\d+(?:\\.\\d+)?)\\s*\\}`
);

// Resolve LOUDNORM_FILTER for a concrete target the way Encore's SpEL would:
// substitute `#{profileParams['targetI']?:<default>}` with `requestedTarget`
// when supplied, otherwise leave the `?:` default in force. `requestedTarget`
// undefined models a request that omits profileParams (default applies).
function resolveLoudnormFilter(requestedTarget?: number): string {
  const match = LOUDNORM_FILTER.match(LOUDNORM_TARGET_SPEL);
  if (!match) {
    throw new Error(
      `loudnorm filter no longer carries a profileParams['${LOUDNORM_TARGET_PARAM}'] SpEL target; ` +
        `test is out of date with src/services/builtin-profiles.ts (got: ${LOUDNORM_FILTER})`
    );
  }
  const effective = requestedTarget ?? Number(match[1]);
  return LOUDNORM_FILTER.replace(LOUDNORM_TARGET_SPEL, `${effective}`);
}

// ---------------------------------------------------------------------------
// Measurement backend capability gate.
// ---------------------------------------------------------------------------

// Probe for a usable ffmpeg. Returns true only if `ffmpeg -version` runs. Any
// error (ENOENT / non-zero) => measurement backend unavailable => cases skip.
function ffmpegAvailable(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = ffmpegAvailable();
const SKIP_REASON =
  'ffmpeg unavailable — loudness measurement deferred; see #386 / OSC friction log ' +
  'docs/osc-feedback/incoming-loudnorm-measurement-no-backend.md';

// ---------------------------------------------------------------------------
// ffmpeg measurement helpers (only invoked when HAS_FFMPEG).
// ---------------------------------------------------------------------------

type LoudnessMeasurement = {
  integratedLufs: number;
  truePeakDbtp: number;
};

// Run ffmpeg to: synthesize a stereo sine source at `sourceLoudnessLufs`, apply
// the profile's exact loudnorm filter targeting `filter`, then re-measure the
// OUTPUT integrated loudness and true peak via the `ebur128` filter (independent
// of loudnorm's own print, so the measurement is not self-reported by the same
// filter that did the correction). ffmpeg writes ebur128 summary to stderr; we
// parse "I:" (integrated LUFS) and "Peak:" (true peak dBTP) from the summary.
function measureNormalisedOutput(args: {
  sourceLoudnessLufs: number;
  filter: string;
  workdir: string;
}): LoudnessMeasurement {
  const { sourceLoudnessLufs, filter } = args;

  // Synthesize a 5s stereo tone, pre-normalise it to a KNOWN source loudness so
  // the "already-compliant" case can start at ~target, then apply the profile
  // filter, then measure the result with ebur128 and discard audio to null.
  //
  // Chain: sine source -> loudnorm to source loudness (establish known input) ->
  //        <profile filter> -> ebur128 (measure) -> -f null.
  const preNorm = `loudnorm=I=${sourceLoudnessLufs}:TP=-2:LRA=7`;
  const filterChain = `${preNorm},${filter},ebur128=peak=true`;

  let stderr = '';
  try {
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostats',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:duration=5:sample_rate=48000',
        '-ac',
        '2',
        '-af',
        filterChain,
        '-f',
        'null',
        '-'
      ],
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }
    );
  } catch (err) {
    // ffmpeg exits non-zero but still writes the ebur128 summary to stderr in
    // most cases; capture it. If truly failed, the parse below throws.
    const e = err as { stderr?: Buffer | string };
    stderr = e.stderr ? e.stderr.toString() : '';
    if (!stderr) throw err;
  }

  // ebur128 prints a "Summary:" block near EOF with the final integrated
  // loudness and true peak. Take the LAST occurrence of each.
  const integrated = lastMatchNumber(stderr, /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g);
  const truePeak = lastMatchNumber(stderr, /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g);

  if (integrated === undefined || truePeak === undefined) {
    throw new Error(
      `could not parse ebur128 measurement from ffmpeg output; stderr tail:\n` +
        stderr.slice(-600)
    );
  }
  return { integratedLufs: integrated, truePeakDbtp: truePeak };
}

function lastMatchNumber(text: string, re: RegExp): number | undefined {
  let value: number | undefined;
  for (const m of text.matchAll(re)) value = Number(m[1]);
  return value;
}

// ---------------------------------------------------------------------------
// ALWAYS-RUN deterministic assertions (no ffmpeg): profileParams honoured.
// These give the harness real executed coverage even without a measurement
// backend — they prove the SAME filter string ffmpeg would receive carries the
// requested integrated-loudness target for each parametrised level.
// ---------------------------------------------------------------------------

describe('loudnorm profile — profileParams target honoured (deterministic, always runs)', () => {
  it("profile default I= equals LOUDNORM_DEFAULT_TARGET_LUFS", () => {
    const match = LOUDNORM_FILTER.match(LOUDNORM_TARGET_SPEL);
    expect(match, `LOUDNORM_FILTER must carry a profileParams['${LOUDNORM_TARGET_PARAM}'] SpEL target`).not.toBeNull();
    // The SpEL `?:` default in the profile is the broadcast default.
    expect(Number(match![1])).toBe(LOUDNORM_DEFAULT_TARGET_LUFS);
    // Sanity: default-resolved filter carries I=-23 and the fixed EBU companions.
    const dflt = resolveLoudnormFilter();
    expect(dflt).toBe(`loudnorm=I=${LOUDNORM_DEFAULT_TARGET_LUFS}:TP=-1:LRA=7`);
  });

  it.each(PARAMETRISED_TARGETS)(
    'resolved filter for requested target %d LUFS carries exactly I=<target> and fixed TP/LRA',
    (target) => {
      const filter = resolveLoudnormFilter(target);
      // The requested target is honoured verbatim as the ffmpeg loudnorm I= value.
      expect(filter).toContain(`I=${target}`);
      // Fixed EBU R128 companions are preserved (not parametrised).
      expect(filter).toContain('TP=-1');
      expect(filter).toContain('LRA=7');
      // No unresolved SpEL leaks into the string ffmpeg would receive.
      expect(filter).not.toContain('profileParams');
      expect(filter).not.toContain('#{');
      // Exact expected form.
      expect(filter).toBe(`loudnorm=I=${target}:TP=-1:LRA=7`);
    }
  );
});

// ---------------------------------------------------------------------------
// MEASUREMENT cases — the #386 acceptance. Gated on ffmpeg; SKIPPED-with-reason
// in this environment (measured-tolerance acceptance DEFERRED, not satisfied).
// ---------------------------------------------------------------------------

describe('loudnorm output measured within tolerance of requested target (issue #386 acceptance)', () => {
  it.skipIf(!HAS_FFMPEG).each(PARAMETRISED_TARGETS)(
    `normalised output lands within ±${TOLERANCE_LUFS} LUFS of requested target %d LUFS` +
      (HAS_FFMPEG ? '' : ` [SKIPPED: ${SKIP_REASON}]`),
    (target) => {
      const workdir = mkdtempSync(join(tmpdir(), 'loudnorm-verify-'));
      try {
        const filter = resolveLoudnormFilter(target);
        // Start from a source deliberately OFF target (e.g. -30 LUFS) so the
        // filter must actually correct it up/down to the requested level.
        const { integratedLufs, truePeakDbtp } = measureNormalisedOutput({
          sourceLoudnessLufs: -30,
          filter,
          workdir
        });
        expect(Math.abs(integratedLufs - target)).toBeLessThanOrEqual(TOLERANCE_LUFS);
        // And the requested true-peak ceiling is respected (no clipping).
        expect(truePeakDbtp).toBeLessThanOrEqual(
          TRUE_PEAK_CEILING_DBTP + TRUE_PEAK_SLACK_DBTP
        );
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(!HAS_FFMPEG)(
    'already-compliant source (~-23 LUFS) stays within tolerance and is not degraded (no true-peak violation)' +
      (HAS_FFMPEG ? '' : ` [SKIPPED: ${SKIP_REASON}]`),
    () => {
      const workdir = mkdtempSync(join(tmpdir(), 'loudnorm-verify-compliant-'));
      try {
        // Source already at the broadcast target; the profile must not degrade it.
        const filter = resolveLoudnormFilter(BROADCAST_TARGET_LUFS);
        const { integratedLufs, truePeakDbtp } = measureNormalisedOutput({
          sourceLoudnessLufs: BROADCAST_TARGET_LUFS,
          filter,
          workdir
        });
        // Stays within tolerance of where it already was — not pushed off target.
        expect(Math.abs(integratedLufs - BROADCAST_TARGET_LUFS)).toBeLessThanOrEqual(
          TOLERANCE_LUFS
        );
        // No clipping / true-peak violation introduced.
        expect(truePeakDbtp).toBeLessThanOrEqual(
          TRUE_PEAK_CEILING_DBTP + TRUE_PEAK_SLACK_DBTP
        );
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    }
  );
});
