// Transcoder input network params — reconnect + read timeout (issue #1222).
//
// Three layers are covered, because the default has to survive all three for a
// real job to recover from a source dropout:
//   1. the resolver (which params, which URIs, which env overrides);
//   2. the payload builder (the params land on `inputs[].params`, the one field
//      the transcoder renders as ffmpeg input options);
//   3. the submit path (a job this API creates carries them BY DEFAULT, with no
//      configuration).
//
// Contract the assertions are written against — github.com/Eyevinn/encore at
// tag `v0.2.8-3` (commit aa45875c53ef5e3c296299191bc2cc996d3dc5b3), the build
// the scaler spawns:
//   - `Input.params: LinkedHashMap<String, String?>`,
//     encore-common/src/main/kotlin/se/svt/oss/encore/model/input/Input.kt:41
//     (default `linkedMapOf()` on `AudioVideoInput`, Input.kt:217) — a flat
//     string map on each element of `inputs[]`.
//   - `List<Input>.inputParams`, Input.kt:253-259, emits
//     `input.params.toParams()` before `-i input.accessUri`; `toParams()`
//     (.../model/mediafile/Extensions.kt:72-76) renders each entry as
//     `-<key> <value>`. Hence bare option names and string values.

import { describe, it, expect, vi } from 'vitest';

import {
  DEFAULT_ENCORE_INPUT_RECONNECT_DELAY_MAX_SECONDS,
  DEFAULT_ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS,
  encoreInputParamsFor,
  encoreInputReconnectEnabled,
  isNetworkInputUri
} from './encore-input-params.js';
import { toEncorePayload, type EncoreClient, type EncoreSubmitInput } from './encore-client.js';
import { submitTranscode } from './transcode.js';
import type { JobRepository } from '../data/job-repo.js';
import type { AssetRepository } from '../data/asset-repo.js';

// The four params exactly as the live run on a standalone transcoder confirmed
// them (issue #1222): with these set, a mid-read source cut times out after
// ~10 s, reconnects from the same byte offset and the job finishes with complete
// output; without them it fails with exit code 183 and no output.
const EXPECTED_PARAMS = {
  reconnect: '1',
  reconnect_on_network_error: '1',
  reconnect_delay_max: '30',
  rw_timeout: '10000000'
};

describe('encoreInputParamsFor (issue #1222)', () => {
  it('sets reconnect and a read timeout on an s3:// input by default', () => {
    expect(encoreInputParamsFor('s3://src-bucket/ingest/in.mp4', {})).toEqual(EXPECTED_PARAMS);
  });

  it('sets the same params on an https:// input', () => {
    // The transcoder resolves s3:// to an https URL before ffmpeg
    // (EncoreService.kt:276 -> S3UriConverter.toHttp), so both schemes end up on
    // the same protocol and take the same options.
    expect(encoreInputParamsFor('https://cdn.example.com/source.mp4', {})).toEqual(
      EXPECTED_PARAMS
    );
    expect(encoreInputParamsFor('http://cdn.example.com/source.mp4', {})).toEqual(EXPECTED_PARAMS);
  });

  it('uses seconds for the backoff ceiling and MICROSECONDS for the read timeout', () => {
    // rw_timeout is a microsecond value: 10_000_000 us = 10 s. Getting this unit
    // wrong by 1e6 is the difference between a 10-second and a ~3-hour deadline.
    expect(DEFAULT_ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS).toBe(10_000_000);
    expect(DEFAULT_ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS / 1_000_000).toBe(10);
    expect(DEFAULT_ENCORE_INPUT_RECONNECT_DELAY_MAX_SECONDS).toBe(30);
  });

  it('emits bare ffmpeg option names and string values only', () => {
    const params = encoreInputParamsFor('s3://src-bucket/in.mp4', {}) ?? {};
    for (const [key, value] of Object.entries(params)) {
      // `toParams()` prepends the dash itself, so a leading dash here would
      // reach ffmpeg as `--reconnect`.
      expect(key.startsWith('-')).toBe(false);
      // Input.params is Map<String, String?> — values are strings, not numbers.
      expect(typeof value).toBe('string');
    }
    expect(Object.keys(params).sort()).toEqual([
      'reconnect',
      'reconnect_delay_max',
      'reconnect_on_network_error',
      'rw_timeout'
    ]);
  });

  it('sets no params on a local input, where a network option would be fatal to ffmpeg', () => {
    // `-reconnect 1` on an input that opens no http protocol aborts the run with
    // "Option reconnect not found.", so a non-network input must stay bare.
    expect(encoreInputParamsFor('ingest/in.mp4', {})).toBeUndefined();
    expect(encoreInputParamsFor('/mnt/media/in.mp4', {})).toBeUndefined();
    expect(encoreInputParamsFor('file:///mnt/media/in.mp4', {})).toBeUndefined();
    expect(isNetworkInputUri('s3://b/k')).toBe(true);
    expect(isNetworkInputUri('/mnt/media/in.mp4')).toBe(false);
  });

  it('lets an operator retune both values via env', () => {
    const params = encoreInputParamsFor('s3://src-bucket/in.mp4', {
      ENCORE_INPUT_RECONNECT_DELAY_MAX_SECONDS: '60',
      ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS: '5000000'
    });
    expect(params).toEqual({
      reconnect: '1',
      reconnect_on_network_error: '1',
      reconnect_delay_max: '60',
      rw_timeout: '5000000'
    });
  });

  it('falls back to the defaults on an unparseable or non-positive override', () => {
    expect(
      encoreInputParamsFor('s3://src-bucket/in.mp4', {
        ENCORE_INPUT_RECONNECT_DELAY_MAX_SECONDS: 'soon',
        ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS: '0'
      })
    ).toEqual(EXPECTED_PARAMS);
  });

  it('falls back to the defaults on a fractional sub-1 override instead of emitting "0"', () => {
    // Regression, PR #1230 review: the env helper used to validate the parsed
    // number and floor it afterwards, so "0.5" passed the `> 0` guard and then
    // truncated to 0 — emitting reconnect_delay_max: "0" and rw_timeout: "0",
    // which is the bound REMOVED rather than retuned (ffmpeg reads rw_timeout=0
    // as no read deadline at all). The value that is emitted is the value that
    // has to satisfy `> 0`, so flooring now happens before validation.
    const params = encoreInputParamsFor('s3://src-bucket/in.mp4', {
      ENCORE_INPUT_RECONNECT_DELAY_MAX_SECONDS: '0.5',
      ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS: '0.9'
    });
    expect(params).toEqual(EXPECTED_PARAMS);
    expect(params?.['rw_timeout']).not.toBe('0');
    expect(params?.['reconnect_delay_max']).not.toBe('0');

    // A fraction that floors to a positive integer is still honoured — it is
    // truncated to whole units, not rejected.
    expect(
      encoreInputParamsFor('s3://src-bucket/in.mp4', {
        ENCORE_INPUT_RECONNECT_DELAY_MAX_SECONDS: '45.7',
        ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS: '2500000.5'
      })
    ).toEqual({
      reconnect: '1',
      reconnect_on_network_error: '1',
      reconnect_delay_max: '45',
      rw_timeout: '2500000'
    });
  });

  it('can be switched off entirely for diagnosis, but only explicitly', () => {
    expect(
      encoreInputParamsFor('s3://src-bucket/in.mp4', { ENCORE_INPUT_RECONNECT_ENABLED: 'false' })
    ).toBeUndefined();
    // Anything else, including unset, keeps the recovering behaviour on.
    expect(encoreInputReconnectEnabled({})).toBe(true);
    expect(encoreInputReconnectEnabled({ ENCORE_INPUT_RECONNECT_ENABLED: 'true' })).toBe(true);
    expect(encoreInputReconnectEnabled({ ENCORE_INPUT_RECONNECT_ENABLED: 'FALSE' })).toBe(false);
  });
});

describe('toEncorePayload input params (issue #1222)', () => {
  const base = {
    externalId: 'workspace-a__job-1',
    inputUri: 's3://src/in.mp4',
    outputUri: 's3://out/transcode/a/j',
    profile: 'program'
  };

  it('sets the params map on the created input object, not on the job root', () => {
    const payload = toEncorePayload({ ...base, inputParams: EXPECTED_PARAMS });
    expect(payload['inputs']).toEqual([
      { uri: 's3://src/in.mp4', type: 'AudioVideo', params: EXPECTED_PARAMS }
    ]);
    // `params` is a field of Input (Input.kt:41), not of EncoreJob: a top-level
    // key would be silently ignored.
    expect('params' in payload).toBe(false);
    // And it is independent of profileParams, which is a job-root field.
    expect('profileParams' in payload).toBe(false);
  });

  it('omits the params key when none were resolved, leaving the input untouched', () => {
    const payload = toEncorePayload(base);
    expect(payload['inputs']).toEqual([{ uri: 's3://src/in.mp4', type: 'AudioVideo' }]);
    const empty = toEncorePayload({ ...base, inputParams: {} });
    expect(empty['inputs']).toEqual([{ uri: 's3://src/in.mp4', type: 'AudioVideo' }]);
  });

  it('serializes the params into the POST /encoreJobs body', async () => {
    const doFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async text() {
        return '';
      },
      async json() {
        return { id: 'enc-1' };
      }
    } as unknown as Response);
    const { makeHttpEncoreClient } = await import('./encore-client.js');
    const client = makeHttpEncoreClient({
      baseUrl: 'https://transcoder.example.io/',
      getToken: async () => 'sat',
      fetch: doFetch as unknown as typeof globalThis.fetch
    });
    await client.submit({ ...base, inputParams: EXPECTED_PARAMS });
    const body = JSON.parse((doFetch.mock.calls[0]?.[1] as { body: string }).body) as {
      inputs: Array<Record<string, unknown>>;
    };
    expect(body.inputs[0]?.['params']).toEqual(EXPECTED_PARAMS);
  });
});

describe('submitTranscode sets input params by default (issue #1222)', () => {
  function fakeJobs(): JobRepository {
    const job = { id: 'job-1', status: 'created' } as unknown as Awaited<
      ReturnType<JobRepository['create']>
    >;
    return {
      create: vi.fn(async () => job),
      update: vi.fn(async () => job),
      get: vi.fn(async () => job),
      list: vi.fn(async () => ({ items: [], total: 0 })),
      findByEncoreJobId: vi.fn(async () => undefined)
    } as unknown as JobRepository;
  }

  function fakeEncore(): { encore: EncoreClient; submitted: EncoreSubmitInput[] } {
    const submitted: EncoreSubmitInput[] = [];
    const encore = {
      submit: vi.fn(async (input: EncoreSubmitInput) => {
        submitted.push(input);
        return { encoreInternalId: 'enc-1' };
      }),
      getJobStatus: vi.fn(),
      cancel: vi.fn()
    } as unknown as EncoreClient;
    return { encore, submitted };
  }

  const baseParams = {
    workspaceId: 'ctx',
    sourceAssetId: 'asset-1',
    sourceObjectKey: 'ingest/in.mp4',
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket'
  };

  it('a submitted job carries reconnect + read timeout with no configuration at all', async () => {
    const jobs = fakeJobs();
    const { encore, submitted } = fakeEncore();

    await submitTranscode(
      { ...baseParams, preset: 'program' },
      { jobs, assets: {} as AssetRepository, encore }
    );

    expect(submitted).toHaveLength(1);
    expect(submitted[0].inputParams).toEqual(EXPECTED_PARAMS);
    // And they reach the wire payload on the input the job actually reads.
    const payload = toEncorePayload(submitted[0]);
    expect(payload['inputs']).toEqual([
      { uri: 's3://src-bucket/ingest/in.mp4', type: 'AudioVideo', params: EXPECTED_PARAMS }
    ]);
  });

  it('honours the operator override on the submit path too', async () => {
    const jobs = fakeJobs();
    const { encore, submitted } = fakeEncore();
    const previous = process.env['ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS'];
    process.env['ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS'] = '2500000';
    try {
      await submitTranscode(
        { ...baseParams, preset: 'program' },
        { jobs, assets: {} as AssetRepository, encore }
      );
    } finally {
      if (previous === undefined) delete process.env['ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS'];
      else process.env['ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS'] = previous;
    }
    expect(submitted[0].inputParams?.['rw_timeout']).toBe('2500000');
    expect(submitted[0].inputParams?.['reconnect']).toBe('1');
  });
});
