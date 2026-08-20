// TAMS-address query contract (issue #174). Contract-definition tests: the
// schema module only, no handler (that is #175).

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  TamsQueryParamsSchema,
  resolveTamsQueryMode,
  TamsQueryError,
  TAMS_QUERY_ERROR_STATUS,
  TAMS_QUERY_MODES,
  TAMS_DEFERRED_MODES,
  TAMS_QUERY_MAX_LIMIT
} from '../src/tams/tams-query-contract.js';

const FLOW_ID = '11111111-2222-3333-4444-555555555555';
const TIMERANGE = '[0:0_10:0)';

describe('TAMS-address query contract (#174)', () => {
  describe('v1 modes + defer list', () => {
    it('enumerates exactly the two v1 modes', () => {
      expect(TAMS_QUERY_MODES).toEqual(['flowId', 'flowIdWithTimerange']);
    });

    it('explicitly defers sourceId, segmentRef, and timerangeOnly', () => {
      expect(TAMS_DEFERRED_MODES).toEqual(['sourceId', 'segmentRef', 'timerangeOnly']);
    });
  });

  describe('valid params', () => {
    it('accepts a valid flowId (flowId mode)', () => {
      const addr = resolveTamsQueryMode({ flowId: FLOW_ID });
      expect(addr.mode).toBe('flowId');
      expect(addr.flowId).toBe(FLOW_ID);
      expect('timerange' in addr).toBe(false);
    });

    it('accepts a valid flowId + timerange (flowIdWithTimerange mode)', () => {
      const addr = resolveTamsQueryMode({ flowId: FLOW_ID, timerange: TIMERANGE });
      expect(addr.mode).toBe('flowIdWithTimerange');
      expect(addr.flowId).toBe(FLOW_ID);
      if (addr.mode === 'flowIdWithTimerange') {
        expect(addr.timerange).toBe(TIMERANGE);
      }
    });

    it('coerces and passes through pagination params', () => {
      const parsed = TamsQueryParamsSchema.parse({ flowId: FLOW_ID, limit: '25', offset: '10' });
      expect(parsed.limit).toBe(25);
      expect(parsed.offset).toBe(10);
    });
  });

  describe('mode discrimination', () => {
    it('selects flowId when timerange is absent and flowIdWithTimerange when present', () => {
      expect(resolveTamsQueryMode({ flowId: FLOW_ID }).mode).toBe('flowId');
      expect(resolveTamsQueryMode({ flowId: FLOW_ID, timerange: TIMERANGE }).mode).toBe(
        'flowIdWithTimerange'
      );
    });
  });

  describe('malformed input is rejected (=> 400)', () => {
    it('rejects a flowId that is not a UUID', () => {
      expect(() => resolveTamsQueryMode({ flowId: 'not-a-uuid' })).toThrow(z.ZodError);
    });

    it('rejects a missing flowId (required in every v1 mode)', () => {
      expect(() => resolveTamsQueryMode({ timerange: TIMERANGE })).toThrow(z.ZodError);
    });

    it('rejects a malformed TAI timerange', () => {
      expect(() => resolveTamsQueryMode({ flowId: FLOW_ID, timerange: 'nonsense' })).toThrow(
        z.ZodError
      );
    });

    it('rejects unknown/unexpected query params (strict)', () => {
      expect(() => resolveTamsQueryMode({ flowId: FLOW_ID, sourceId: 'x' })).toThrow(z.ZodError);
    });

    it('rejects limit above the max', () => {
      expect(() =>
        resolveTamsQueryMode({ flowId: FLOW_ID, limit: String(TAMS_QUERY_MAX_LIMIT + 1) })
      ).toThrow(z.ZodError);
    });
  });

  describe('error taxonomy -> HTTP status mapping', () => {
    it('maps each taxonomy code to the pinned status', () => {
      expect(TAMS_QUERY_ERROR_STATUS.malformed).toBe(400);
      expect(TAMS_QUERY_ERROR_STATUS.unknown).toBe(404);
      expect(TAMS_QUERY_ERROR_STATUS.notYetIndexed).toBe(404);
      expect(TAMS_QUERY_ERROR_STATUS.ambiguous).toBe(409);
    });

    it('TamsQueryError carries the code and its pre-mapped status', () => {
      const err = new TamsQueryError('unknown');
      expect(err.code).toBe('unknown');
      expect(err.status).toBe(404);
      expect(err).toBeInstanceOf(Error);
    });
  });
});
