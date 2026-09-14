// Encode-completion event payload schema (issue #691).
//
// These tests pin the schema contract itself: the required/optional split, the
// unit of encodeDurationMs (milliseconds), the resolution-tier boundaries, and
// the ADR-012 D3 duration derivation. They do NOT exercise event emission
// (#693) or transport (#692) — neither exists yet and both are out of scope for
// this schema-definition issue.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - encodeCompletionEventSchema / EncodeCompletionEvent, RESOLUTION_TIERS,
//     resolutionTierForHeight, encodeDurationMsFromAttempt,
//     ENCODE_COMPLETION_EVENT_TYPE — src/pipeline/encode-completion-event.ts.
//   - ADR-012 Decision 3 (elapsed = last attempt endedAt - startedAt) —
//     docs/architecture/ADR-012-encode-attempt-shape.md:131-147.

import { describe, it, expect } from 'vitest';

import {
  ENCODE_COMPLETION_EVENT_TYPE,
  RESOLUTION_TIERS,
  encodeCompletionEventSchema,
  encodeDurationMsFromAttempt,
  resolutionTierForHeight,
  type EncodeCompletionEvent
} from './encode-completion-event.js';

describe('encode-completion event schema (#691)', () => {
  const minimalValid: EncodeCompletionEvent = {
    eventType: ENCODE_COMPLETION_EVENT_TYPE,
    jobId: 'job-1',
    assetId: 'asset-1',
    encodeDurationMs: 42_000,
    resolutionTier: 'fhd',
    occurredAt: '2026-09-14T10:00:00.000Z'
  };

  it('accepts a payload with only the required fields', () => {
    const parsed = encodeCompletionEventSchema.parse(minimalValid);
    expect(parsed.eventType).toBe('encode.completed');
    // Optional companions are absent, not defaulted.
    expect(parsed.codec).toBeUndefined();
    expect(parsed.completedAt).toBeUndefined();
  });

  it('accepts a fully-populated payload', () => {
    const full: EncodeCompletionEvent = {
      ...minimalValid,
      codec: 'h264',
      height: 1080,
      width: 1920,
      outputFormat: 'mp4',
      bitrateBps: 5_000_000,
      profile: 'program',
      renditionCount: 4,
      completedAt: '2026-09-14T10:00:00.000Z'
    };
    expect(() => encodeCompletionEventSchema.parse(full)).not.toThrow();
  });

  it('rejects a payload missing a required field', () => {
    const { encodeDurationMs, ...withoutDuration } = minimalValid;
    void encodeDurationMs;
    expect(() => encodeCompletionEventSchema.parse(withoutDuration)).toThrow();
  });

  it('rejects a wrong event type literal', () => {
    expect(() =>
      encodeCompletionEventSchema.parse({ ...minimalValid, eventType: 'transcode.complete' })
    ).toThrow();
  });

  it('enforces milliseconds: encodeDurationMs must be a non-negative integer', () => {
    expect(() => encodeCompletionEventSchema.parse({ ...minimalValid, encodeDurationMs: -1 })).toThrow();
    expect(() => encodeCompletionEventSchema.parse({ ...minimalValid, encodeDurationMs: 12.5 })).toThrow();
  });

  it('rejects an unknown resolution tier value', () => {
    expect(() => encodeCompletionEventSchema.parse({ ...minimalValid, resolutionTier: '4k' })).toThrow();
  });
});

describe('resolutionTierForHeight (#691)', () => {
  it('maps heights to the documented tier boundaries', () => {
    expect(resolutionTierForHeight(360)).toBe('sd');
    expect(resolutionTierForHeight(480)).toBe('sd');
    expect(resolutionTierForHeight(720)).toBe('hd');
    expect(resolutionTierForHeight(1079)).toBe('hd');
    expect(resolutionTierForHeight(1080)).toBe('fhd');
    expect(resolutionTierForHeight(1440)).toBe('fhd');
    expect(resolutionTierForHeight(2160)).toBe('uhd');
    expect(resolutionTierForHeight(4320)).toBe('uhd');
  });

  it('maps a missing / non-positive height to the explicit unknown bucket', () => {
    expect(resolutionTierForHeight(undefined)).toBe('unknown');
    expect(resolutionTierForHeight(0)).toBe('unknown');
    expect(resolutionTierForHeight(-100)).toBe('unknown');
  });

  it('every returned tier is a member of RESOLUTION_TIERS', () => {
    for (const h of [0, 360, 720, 1080, 2160, undefined]) {
      expect(RESOLUTION_TIERS).toContain(resolutionTierForHeight(h));
    }
  });
});

describe('encodeDurationMsFromAttempt — ADR-012 D3 (#691)', () => {
  it('derives the millisecond delta of the successful attempt', () => {
    const ms = encodeDurationMsFromAttempt({
      startedAt: '2026-09-14T10:00:00.000Z',
      endedAt: '2026-09-14T10:00:42.000Z'
    });
    expect(ms).toBe(42_000);
  });

  it('returns undefined when the attempt is still in flight (no endedAt)', () => {
    expect(encodeDurationMsFromAttempt({ startedAt: '2026-09-14T10:00:00.000Z' })).toBeUndefined();
  });

  it('returns undefined for an unparseable or negative timing pair', () => {
    expect(encodeDurationMsFromAttempt({ startedAt: 'not-a-date', endedAt: '2026-09-14T10:00:00.000Z' })).toBeUndefined();
    expect(
      encodeDurationMsFromAttempt({ startedAt: '2026-09-14T10:00:42.000Z', endedAt: '2026-09-14T10:00:00.000Z' })
    ).toBeUndefined();
  });

  it('returns undefined for an absent attempt', () => {
    expect(encodeDurationMsFromAttempt(undefined)).toBeUndefined();
  });
});
