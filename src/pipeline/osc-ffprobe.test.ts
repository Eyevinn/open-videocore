// Unit tests for the external-backend source path of the OSC ffprobe runner
// (issue #548). Verifies the ephemeral eyevinn-ffmpeg-s3 job body carries the
// registered endpoint + credential REFERENCES and probes `s3://bucket/key` in
// place, and that a default (presigned-URL) source is unchanged.

import { describe, it, expect, vi } from 'vitest';
import {
  makeOscProbeRunner,
  ffprobeCmdLine,
  ffprobeExternalCmdLine,
  parseFfmpegLogToProbeResult
} from './osc-ffprobe.js';
import { parseFfprobe } from './metadata-extractor.js';
import type { ExternalProbeSource } from './metadata-extractor.js';

const PROBE_LOG =
  "Input #0, mov,mp4, from 'x.mp4':\n" +
  '  Duration: 00:00:10.00, start: 0.000000, bitrate: 1000 kb/s\n' +
  '    Stream #0:0(und): Video: h264, yuv420p, 1920x1080, 900 kb/s, 25 fps\n';

function fakeApi() {
  const createJob = vi.fn(async () => ({}));
  const api = {
    context: {
      getServiceAccessToken: vi.fn(async () => 'sat-token')
    } as unknown as import('@osaas/client-core').Context,
    createJob: createJob as unknown as typeof import('@osaas/client-core').createJob,
    getJob: vi.fn(async () => ({ status: 'SuccessCriteriaMet' })) as never,
    getLogsForInstance: vi.fn(async () => PROBE_LOG) as never,
    removeJob: vi.fn(async () => ({})) as never
  };
  return { api, createJob };
}

describe('ffprobe command lines', () => {
  it('default source probes the given URL via the null muxer', () => {
    expect(ffprobeCmdLine('https://example.com/a.mp4')).toBe('-i "https://example.com/a.mp4" -f null -');
  });
  it('external source probes s3://bucket/key in place', () => {
    expect(ffprobeExternalCmdLine('ext-bkt', 'path/to/a.mp4')).toBe('-i "s3://ext-bkt/path/to/a.mp4" -f null -');
  });
});

// Frame rate + start timecode off the ffmpeg log (issue #1066). The service runs
// ffmpeg, not ffprobe, so the rate is the decimal on the stream line rather than a
// rational — these cases pin the scrape AND the value the extractor ends up with.
describe('parseFfmpegLogToProbeResult — frame rate and start timecode (issue #1066)', () => {
  it('reads an integer frame rate off the video stream line', () => {
    const result = parseFfmpegLogToProbeResult(PROBE_LOG);
    expect(result.streams?.[0]?.r_frame_rate).toBe('25');
    expect(parseFfprobe(result, 'now').frameRate).toBe(25);
  });

  it('reads a 29.97 fps source and its start timecode', () => {
    const log =
      "Input #0, mov,mp4, from 'ntsc.mov':\n" +
      '  Metadata:\n' +
      '    timecode        : 01:00:00:00\n' +
      '  Duration: 00:00:10.01, start: 0.000000, bitrate: 5131 kb/s\n' +
      '    Stream #0:0(und): Video: h264, yuv420p, 1920x1080, 4814 kb/s, 29.97 fps, 29.97 tbr\n' +
      '    Stream #0:1(und): Audio: aac, 48000 Hz, stereo, 317 kb/s\n';
    const md = parseFfprobe(parseFfmpegLogToProbeResult(log), 'now');
    expect(md.frameRate).toBeCloseTo(29.97, 2);
    expect(md.startTimecode).toBe('01:00:00:00');
  });

  it('falls back to tbr when ffmpeg prints no fps, and omits both when it prints neither', () => {
    const tbrOnly =
      "Input #0, matroska, from 'x.mkv':\n" +
      '  Duration: 00:00:10.00, start: 0.000000, bitrate: 1000 kb/s\n' +
      '    Stream #0:0: Video: vp9, yuv420p, 1280x720, 50 tbr\n';
    expect(parseFfprobe(parseFfmpegLogToProbeResult(tbrOnly), 'now').frameRate).toBe(50);

    const neither =
      "Input #0, matroska, from 'x.mkv':\n" +
      '  Duration: 00:00:10.00, start: 0.000000, bitrate: 1000 kb/s\n' +
      '    Stream #0:0: Video: vp9, yuv420p, 1280x720\n';
    const md = parseFfprobe(parseFfmpegLogToProbeResult(neither), 'now');
    expect(md.frameRate).toBeUndefined();
    expect(md.startTimecode).toBeUndefined();
  });

  it('an audio-only source yields no frame rate and still parses', () => {
    const log =
      "Input #0, mov,mp4, from 'a.m4a':\n" +
      '  Duration: 00:00:30.00, start: 0.000000, bitrate: 128 kb/s\n' +
      '    Stream #0:0(und): Audio: aac, 48000 Hz, stereo, 128 kb/s\n';
    const md = parseFfprobe(parseFfmpegLogToProbeResult(log), 'now');
    expect(md.frameRate).toBeUndefined();
    expect(md.audioTracks).toHaveLength(1);
  });
});

describe('makeOscProbeRunner — external-backend source (issue #548)', () => {
  it('injects endpoint + credential REFERENCES into the job body and reads s3://bucket/key', async () => {
    const { api, createJob } = fakeApi();
    const runner = makeOscProbeRunner(api);
    const source: ExternalProbeSource = {
      bucket: 'ext-bkt',
      objectKey: 'in/a.mp4',
      awsAccessKeyId: 'AKIA',
      awsSecretAccessKey: '{{secrets.storagebackend.b1.source.awssecretaccesskey}}',
      s3EndpointUrl: 'https://s3.example.com',
      awsRegion: 'eu-west-1',
      awsSessionToken: '{{secrets.storagebackend.b1.source.awssessiontoken}}'
    };
    const result = await runner(source);
    expect(result.streams?.[0]?.codec_name).toBe('h264');

    const body = (createJob.mock.calls[0] as unknown as unknown[])[3] as Record<string, string>;
    expect(body.cmdLineArgs).toBe('-i "s3://ext-bkt/in/a.mp4" -f null -');
    expect(body.awsAccessKeyId).toBe('AKIA');
    expect(body.s3EndpointUrl).toBe('https://s3.example.com');
    expect(body.awsRegion).toBe('eu-west-1');
    // The two secret fields are {{secrets.*}} references, resolved by OSC at job
    // time — never literal credential values.
    expect(body.awsSecretAccessKey).toMatch(/^\{\{secrets\..+\}\}$/);
    expect(body.awsSessionToken).toMatch(/^\{\{secrets\..+\}\}$/);
  });

  it('default (presigned-URL) source carries no S3 credential fields', async () => {
    const { api, createJob } = fakeApi();
    const runner = makeOscProbeRunner(api);
    await runner('https://minio.example/presigned');
    const body = (createJob.mock.calls[0] as unknown as unknown[])[3] as Record<string, string>;
    expect(body.cmdLineArgs).toBe('-i "https://minio.example/presigned" -f null -');
    expect(body).not.toHaveProperty('awsAccessKeyId');
    expect(body).not.toHaveProperty('awsSecretAccessKey');
  });
});
