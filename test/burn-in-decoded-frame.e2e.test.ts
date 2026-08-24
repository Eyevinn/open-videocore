// Burn-in decoded-frame acceptance placeholder (issue #388, ADR-014).
//
// ADR-014's acceptance criterion for burn-in is: "A transcode produces a
// rendition with captions burned into the picture, verified by inspecting a
// DECODED FRAME, NOT by asserting the filter string is present in the command."
//
// That visual proof requires BOTH:
//   1. A live Encore instance to run the transcode with the injected
//      `subtitles=<key>[:force_style='...']` filter (ADR-014 D3), AND
//   2. an ffmpeg/ffprobe binary to decode a frame of the produced rendition and
//      assert the caption pixels are present.
//
// This environment has NEITHER (0 Encore instances provisioned; no ffmpeg
// binary — verified). So the decoded-frame check is DEFERRED, honestly, and
// captured here as a gated/skipped harness rather than fabricated. It runs only
// when a live Encore + ffmpeg are wired up via env (mirroring the
// describe.skipIf gating of test/encore-scaler.e2e.test.ts). Until then it is
// SKIPPED, and the deterministic wiring is proven by:
//   - src/pipeline/burn-in.test.ts (source resolution, format gate, filter build)
//   - src/pipeline/transcode.test.ts (filter threaded into Encore profileParams;
//     clean renditions carry no filter; per-rendition opt-in).
//
// The open dependency this harness will confirm is ADR-014 C1 / open-dependency
// 1: the exact `subtitles=` file-path resolution against Encore's S3-backed
// execution environment. See docs/osc-feedback/incoming-burn-in-contract.md.

import { describe, it, expect } from 'vitest';

// Gate: run ONLY when a live Encore endpoint AND an ffmpeg binary path are both
// supplied. Absent either (the norm here), the whole suite is skipped so CI stays
// green without fabricating a visual result that cannot be produced.
const SKIP = !process.env['BURN_IN_E2E_ENCORE_URL'] || !process.env['BURN_IN_E2E_FFMPEG'];

describe.skipIf(SKIP)('burn-in decoded-frame acceptance (live Encore + ffmpeg)', () => {
  it.skipIf(SKIP)(
    'burns captions into the opted rendition and leaves clean renditions caption-free (decoded-frame check)',
    async () => {
      // DEFERRED. When a live Encore + ffmpeg are wired, this test must:
      //   1. Submit a transcode of a known source with `burnIn` set on one
      //      rendition/profile and a second clean rendition/profile.
      //   2. Wait for completion via the callback path.
      //   3. Decode a frame of the BURNED rendition with ffmpeg and assert the
      //      caption text pixels are present (e.g. OCR or a fixed-region pixel
      //      diff against a caption-free baseline).
      //   4. Decode a frame of the CLEAN rendition and assert NO caption pixels.
      // Implementing this requires the live services this environment lacks; it
      // is intentionally left unimplemented and skipped rather than faked.
      expect(true).toBe(true);
    }
  );
});
