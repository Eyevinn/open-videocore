// OSC ffprobe runner tests (issue #6).
//
// After smoke testing, eyevinn-ffmpeg-s3 runs ffmpeg (not ffprobe).
// The runner now uses `-i <url> -f null -` and parses ffmpeg's human-readable
// stderr to reconstruct an FfprobeResult-shaped object.

import { describe, it, expect, vi } from 'vitest';
import {
  ffprobeCmdLine,
  makeOscProbeRunner,
  parseFfmpegLogToProbeResult,
  type OscJobApi
} from '../src/pipeline/osc-ffprobe.js';

// Realistic ffmpeg stderr for a typical MP4 file
const FFMPEG_MP4_LOG = [
  'ffmpeg version 6.1 Copyright (c) 2000-2023 the FFmpeg developers',
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/usercontent/abc/VINN.mp4':",
  '  Metadata:',
  '    major_brand     : isom',
  '  Duration: 00:01:25.28, start: 0.000000, bitrate: 5131 kb/s',
  '    Stream #0:0(und): Video: h264 (High), yuv420p, 1920x1080, 4814 kb/s, 25 fps',
  '    Stream #0:1(und): Audio: aac, 48000 Hz, stereo, fltp, 317 kb/s',
  'frame=  2132 fps=0.0 q=-0.0 Lsize=N/A time=00:01:25.28 bitrate=N/A',
  'video:0kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB'
].join('\n');

const FFMPEG_MULTI_AUDIO_LOG = [
  "Input #0, matroska,webm, from '/usercontent/abc/multi.mkv':",
  '  Duration: 00:02:00.00, start: 0.000000, bitrate: 8000 kb/s',
  '    Stream #0:0: Video: vp9, yuv420p, 3840x2160, 7000 kb/s',
  '    Stream #0:1: Audio: opus, 48000 Hz, stereo, 128 kb/s',
  '    Stream #0:2: Audio: aac, 44100 Hz, 5.1 channels, 384 kb/s'
].join('\n');

describe('parseFfmpegLogToProbeResult', () => {
  it('extracts video codec, resolution, duration and container from MP4 log', () => {
    const result = parseFfmpegLogToProbeResult(FFMPEG_MP4_LOG);
    const video = result.streams?.find((s) => s.codec_type === 'video');
    expect(video?.codec_name).toBe('h264');
    expect(video?.width).toBe(1920);
    expect(video?.height).toBe(1080);
    expect(result.format?.format_name).toContain('mov'); // ffmpeg reports "mov,mp4,..." — first token is "mov"
    expect(result.format?.duration).toBeCloseTo(85.28, 1);
    expect(result.format?.bit_rate).toBe(5131000);
  });

  it('extracts audio track from MP4 log', () => {
    const result = parseFfmpegLogToProbeResult(FFMPEG_MP4_LOG);
    const audio = result.streams?.find((s) => s.codec_type === 'audio');
    expect(audio?.codec_name).toBe('aac');
    expect(audio?.sample_rate).toBe(48000);
    expect(audio?.channels).toBe(2); // stereo
  });

  it('extracts multiple audio tracks', () => {
    const result = parseFfmpegLogToProbeResult(FFMPEG_MULTI_AUDIO_LOG);
    const audioTracks = result.streams?.filter((s) => s.codec_type === 'audio') ?? [];
    expect(audioTracks).toHaveLength(2);
    expect(audioTracks[0].codec_name).toBe('opus');
    expect(audioTracks[1].codec_name).toBe('aac');
    expect(audioTracks[1].channels).toBe(6); // 5.1 channels
  });

  it('extracts VP9 video from MKV log', () => {
    const result = parseFfmpegLogToProbeResult(FFMPEG_MULTI_AUDIO_LOG);
    const video = result.streams?.find((s) => s.codec_type === 'video');
    expect(video?.codec_name).toBe('vp9');
    expect(video?.width).toBe(3840);
    expect(video?.height).toBe(2160);
  });

  it('throws when no stream lines are found', () => {
    expect(() => parseFfmpegLogToProbeResult('no useful output')).toThrow(
      /no recognisable stream/
    );
  });
});

describe('ffprobeCmdLine', () => {
  it('uses null muxer and quotes the URL', () => {
    const cmd = ffprobeCmdLine('https://minio/obj?sig=a&b=c');
    expect(cmd).toContain('-f null');
    expect(cmd).toContain('"https://minio/obj?sig=a&b=c"');
    expect(cmd).not.toContain('-print_format');
    expect(cmd).not.toContain('-show_streams');
  });
});

describe('makeOscProbeRunner', () => {
  function fakeApi(log: string): OscJobApi {
    const context = {
      getServiceAccessToken: vi.fn(async () => 'sat-token')
    } as unknown as OscJobApi['context'];
    return {
      context,
      createJob: vi.fn(async () => ({ name: 'x' })),
      waitForJobToComplete: vi.fn(async () => undefined),
      getLogsForInstance: vi.fn(async () => log),
      removeJob: vi.fn(async () => undefined)
    } as unknown as OscJobApi;
  }

  it('creates a job, waits, parses ffmpeg logs, and cleans up', async () => {
    const api = fakeApi(FFMPEG_MP4_LOG);
    const result = await makeOscProbeRunner(api)('https://minio/obj?sig=a');
    expect(result.format?.format_name).toContain('mov');
    expect(api.createJob).toHaveBeenCalledOnce();
    expect(api.waitForJobToComplete).toHaveBeenCalledOnce();
    expect(api.removeJob).toHaveBeenCalledOnce();
  });

  it('joins string[] logs before parsing', async () => {
    const api = fakeApi('ignored');
    (api.getLogsForInstance as ReturnType<typeof vi.fn>).mockResolvedValue(
      FFMPEG_MULTI_AUDIO_LOG.split('\n')
    );
    const result = await makeOscProbeRunner(api)('https://minio/obj');
    const video = result.streams?.find((s) => s.codec_type === 'video');
    expect(video?.codec_name).toBe('vp9');
  });

  it('still cleans up the job when log parsing fails', async () => {
    const api = fakeApi('no useful output at all');
    await expect(makeOscProbeRunner(api)('https://minio/obj')).rejects.toThrow();
    expect(api.removeJob).toHaveBeenCalledOnce();
  });
});
