// Default ProbeRunner backed by the OSC eyevinn-ffmpeg-s3 ephemeral job
// (issue #6).
//
// SMOKE TEST FINDING (2026-06-01): eyevinn-ffmpeg-s3 runs ffmpeg, NOT ffprobe.
// Passing ffprobe flags (-print_format json -show_format -show_streams) caused
// ffmpeg to exit with code 8 (unknown option). HTTPS source URLs are accepted —
// the service downloads the file before running ffmpeg.
//
// Fix: we run ffmpeg with `-i <url> -f null -` (null muxer, no output file).
// ffmpeg prints stream/format info to stderr at the default log level; we parse
// that human-readable text with regex to reconstruct an FfprobeResult-shaped
// object, which feeds into the existing parseFfprobe() path unchanged.
//
// OSC FRICTION (logged): eyevinn-ffmpeg-s3 does not expose ffprobe — only
// ffmpeg. See docs/osc-feedback/incoming-issue6-metadata.md friction #4.

import {
  createJob,
  getLogsForInstance,
  removeJob,
  waitForJobToComplete,
  type Context
} from '@osaas/client-core';
import { FFPROBE_SERVICE_ID } from '../services/stack.js';
import type { FfprobeResult, FfprobeStream, ProbeRunner } from './metadata-extractor.js';

// Subset of the OSC SDK surface this runner needs. Declared structurally so the
// real SDK functions satisfy it and tests can pass lightweight fakes.
export type OscJobApi = {
  context: Context;
  createJob: typeof createJob;
  waitForJobToComplete: typeof waitForJobToComplete;
  getLogsForInstance: typeof getLogsForInstance;
  removeJob: typeof removeJob;
};

// Build the ffmpeg command that probes a file via the null muxer. ffmpeg prints
// stream/format info to stderr at the default log level. The null output `-`
// avoids an output-file requirement without writing bytes anywhere.
export function ffprobeCmdLine(presignedUrl: string): string {
  return `-i "${presignedUrl}" -f null -`;
}

// Parse ffmpeg's human-readable stderr output into an FfprobeResult-shaped
// object so the rest of the pipeline (parseFfprobe in metadata-extractor.ts)
// is unaffected.
//
// Example ffmpeg stderr (condensed):
//   Input #0, mov,mp4,..., from '/usercontent/.../file.mp4':
//     Duration: 00:01:25.28, start: 0.000000, bitrate: 5131 kb/s
//     Stream #0:0(und): Video: h264, yuv420p, 1920x1080, 4814 kb/s, 25 fps
//     Stream #0:1(und): Audio: aac, 48000 Hz, stereo, 317 kb/s
export function parseFfmpegLogToProbeResult(log: string): FfprobeResult {
  // Container format from "Input #0, <format_name>, from …"
  const formatMatch = log.match(/Input #\d+,\s*([^,]+)/);
  const formatName = formatMatch?.[1]?.trim() ?? 'unknown';

  // Duration from "Duration: HH:MM:SS.ss"
  const durMatch = log.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  let durationSeconds = 0;
  if (durMatch) {
    durationSeconds =
      Number(durMatch[1]) * 3600 +
      Number(durMatch[2]) * 60 +
      Number(durMatch[3]);
  }

  // Container bitrate from "bitrate: NNN kb/s" on the Duration line
  const containerBrMatch = log.match(/Duration:[^,]+,\s*start:[^,]+,\s*bitrate:\s*(\d+)\s*kb\/s/);
  const containerBitrate = containerBrMatch ? Number(containerBrMatch[1]) * 1000 : 0;

  // Parse every Stream line
  const streamLines = [...log.matchAll(/Stream #(\d+:\d+)[^:]*:\s*(Video|Audio):([^\n]+)/gi)];
  const streams: FfprobeStream[] = [];

  for (const m of streamLines) {
    const codecType = m[2].toLowerCase(); // 'video' | 'audio'
    const rest = m[3]; // everything after "Video:" or "Audio:"

    // First token before any comma/space is the codec name
    const codecName = rest.trim().split(/[\s,]/)[0] ?? 'unknown';

    if (codecType === 'video') {
      // Resolution: NNNxNNN
      const resMatch = rest.match(/(\d{2,5})x(\d{2,5})/);
      // Stream-level bitrate: NNN kb/s
      const brMatch = rest.match(/(\d+)\s*kb\/s/);
      streams.push({
        codec_type: 'video',
        codec_name: codecName,
        width: resMatch ? Number(resMatch[1]) : undefined,
        height: resMatch ? Number(resMatch[2]) : undefined,
        bit_rate: brMatch ? Number(brMatch[1]) * 1000 : undefined,
        duration: durationSeconds > 0 ? durationSeconds : undefined
      });
    } else if (codecType === 'audio') {
      // Sample rate: NNN Hz
      const srMatch = rest.match(/(\d+)\s*Hz/);
      // Channels: "stereo" → 2, "mono" → 1, "5.1" → 6, "N channels" → N
      let channels = 0;
      if (/stereo/i.test(rest)) channels = 2;
      else if (/mono/i.test(rest)) channels = 1;
      else if (/5\.1/i.test(rest)) channels = 6;
      else if (/7\.1/i.test(rest)) channels = 8;
      else {
        const chMatch = rest.match(/(\d+)\s*channels?/i);
        if (chMatch) channels = Number(chMatch[1]);
      }
      streams.push({
        codec_type: 'audio',
        codec_name: codecName,
        sample_rate: srMatch ? Number(srMatch[1]) : undefined,
        channels: channels > 0 ? channels : undefined
      });
    }
  }

  if (streams.length === 0) {
    throw new Error('ffmpeg produced no recognisable stream information');
  }

  return {
    streams,
    format: {
      format_name: formatName,
      duration: durationSeconds > 0 ? durationSeconds : undefined,
      bit_rate: containerBitrate > 0 ? containerBitrate : undefined
    }
  };
}

// A unique, OSC-valid ephemeral job name. Lowercase alphanumeric, bounded
// length (OSC instance-name constraints, see provision.ts).
function probeJobName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-6);
  return `ffprobe${ts}${rand}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

// Construct the production ProbeRunner. Each invocation creates an ephemeral
// ffprobe job, waits for completion, scrapes the JSON from its logs, and
// best-effort removes the job so spent ephemeral instances do not accumulate.
export function makeOscProbeRunner(api: OscJobApi): ProbeRunner {
  return async (presignedUrl: string): Promise<FfprobeResult> => {
    const sat = await api.context.getServiceAccessToken(FFPROBE_SERVICE_ID);
    const name = probeJobName();
    await api.createJob(api.context, FFPROBE_SERVICE_ID, sat, {
      name,
      cmdLineArgs: ffprobeCmdLine(presignedUrl)
    });
    try {
      await api.waitForJobToComplete(api.context, FFPROBE_SERVICE_ID, name, sat);
      const log = await api.getLogsForInstance(api.context, FFPROBE_SERVICE_ID, name, sat);
      const text = Array.isArray(log) ? log.join('\n') : log;
      return parseFfmpegLogToProbeResult(text);
    } finally {
      // Reclaim the ephemeral instance. Failure here is non-fatal: the probe
      // result (if any) has already been read.
      try {
        await api.removeJob(api.context, FFPROBE_SERVICE_ID, name, sat);
      } catch {
        // ignore cleanup failure
      }
    }
  };
}
