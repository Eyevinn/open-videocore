// Network input params for transcoder job inputs (issue #1222).
//
// THE PROBLEM
// -----------
// Every transcode job this API creates reads its source over the network, and
// until now the job document carried no input params at all. So the ffmpeg
// process inside the transcoder ran with ffmpeg's defaults: no reconnect and no
// read timeout. A source connection that dies mid-read therefore either hangs
// the read indefinitely or kills the job outright — observed as exit code 183
// with zero output — even though the bytes are still there and a reconnect from
// the same offset would finish the encode.
//
// Setting four params per input fixes that: the read times out after ~10 s,
// ffmpeg reconnects from the same byte offset, and the job completes with full
// output. Without them the same interruption fails the job.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// -----------------------------------------------------------
// The transcoder is the OSC-packaged build of SVT Encore. The deployed version
// is the one the scaler spawns — v0.2.8-3, per the live evidence recorded in
// issue #1222 — so every symbol below was read at that exact tag:
// github.com/Eyevinn/encore @ tag `v0.2.8-3`
// (commit `aa45875c53ef5e3c296299191bc2cc996d3dc5b3`, fetched 2026-10-15).
//
//   1. The field. `Input.params: LinkedHashMap<String, String?>`
//      — encore-common/src/main/kotlin/se/svt/oss/encore/model/input/Input.kt:41
//      on the `sealed interface Input`, annotated
//      `@Schema(description = "Input params required to properly decode input",
//      example = """{ "ac": "2" }""")`. Each concrete subtype defaults it to
//      `linkedMapOf()`: `AudioInput.params` (Input.kt:157),
//      `VideoInput.params` (:185), `AudioVideoInput.params` (:217). We submit
//      `type: 'AudioVideo'` (src/pipeline/encore-client.ts:95), i.e.
//      `AudioVideoInput`. So the field is a FLAT STRING MAP on each element of
//      `inputs[]`, NOT a top-level job field, and its default is `{}` — which
//      is exactly why nothing was passed to ffmpeg before.
//
//   2. How the map reaches ffmpeg. `fun List<Input>.inputParams(readDuration:
//      Double?)` — Input.kt:253-259 — emits
//      `input.params.toParams() + ... + listOf("-i", input.accessUri)`, and
//      `toParams()` (encore-common/.../model/mediafile/Extensions.kt:72-76) maps
//      each entry to `listOf("-${entry.key}", entry.value)`. So a key must be
//      the BARE ffmpeg option name with no leading dash, the value a string, and
//      the pair lands BEFORE `-i <uri>` — i.e. as an ffmpeg INPUT option, which
//      is where `reconnect*`/`rw_timeout` have to be to take effect.
//
//   3. Why these params apply to our `s3://` inputs. Our job inputs are
//      `s3://<bucket>/<key>` (src/pipeline/transcode.ts:162), and ffmpeg has no
//      s3 protocol — the transcoder resolves the URI first:
//      `input.accessUri = remoteFileService.getAccessUri(input.uri)`
//      (encore-common/.../service/EncoreService.kt:276) →
//      `S3RemoteFileHandler.getAccessUri` (.../remotefiles/s3/S3RemoteFileHandler.kt:27-33)
//      → `S3UriConverter.toHttp` returns `https://<bucket>.<endpoint>/<key>`
//      (.../remotefiles/s3/S3UriConverter.kt:16-26), or a presigned
//      `https://` GET URL when no endpoint is configured. ffmpeg therefore opens
//      an https URL via its http protocol for BOTH `s3://` and `https://`
//      inputs, which is the protocol whose options these four are. (It is also
//      why the recorded source-read failure reads `Server returned 404 Not
//      Found` for an `s3://` input — libavformat/http.c wording; see
//      src/pipeline/encore-source-read-failure.ts.)
//
//   4. The probe call filters the map itself, so an http-only key is safe to
//      send: `MediaAnalyzerService.analyzeInput` keeps only
//      `input.params.filterKeys { ffprobeValidParams.contains(it) }`
//      (encore-common/.../service/mediaanalyzer/MediaAnalyzerService.kt:58-69,
//      with `getValidFfprobeParams()` at :90 parsing `ffprobe -h`). The first
//      analyze step (`mediainfo`) receives no input params at all: the only
//      params channel out of `analyzeInput` is the one named
//      `ffprobeInputParams`, and the bundled analyzer
//      (`se.svt.oss:media-analyzer:2.0.7`, encore-common/build.gradle.kts:8)
//      threads it to ffprobe only — `MediaAnalyzer.analyze` calls
//      `mediaInfoAnalyzer.analyze(file, disableImageSequenceDetection)` with no
//      params argument to pass anything to (media-analyzer @ tag
//      `release-2.0.7`, src/main/kotlin/se/svt/oss/mediaanalyzer/
//      MediaAnalyzer.kt:33-68), and `MediaInfoAnalyzer.analyze` builds a fixed
//      `mediainfo --Output=JSON <file>` command line (.../mediainfo/
//      MediaInfoAnalyzer.kt:13-30). So the pre-encode analysis window is
//      service-side and outside our reach — logged as OSC friction in
//      `docs/osc-feedback/incoming-issue1222-mediainfo-no-input-params.md`
//      (authoritative copy: same filename under `docs/osc-feedback/` in the
//      agents repo), which also records what we would need from the service to
//      close it.
//
// A NOTE ON WHY LOCAL PATHS ARE EXCLUDED
// --------------------------------------
// `reconnect`, `reconnect_on_network_error` and `reconnect_delay_max` are
// private options of ffmpeg's http protocol (`rw_timeout` is generic to any
// URLContext). ffmpeg treats an input option that no protocol/demuxer consumes
// as fatal ("Option reconnect not found."), so these keys must only be set on
// inputs that actually open a network protocol. Every input we build today is
// `s3://`, but the scheme is checked rather than assumed, with the same scheme
// set the ingest path already calls network sources: `ParsedSource` =
// `{ scheme: 'http' | 'https' | 's3'; url: URL }` (src/pipeline/source.ts:34).

// The four params, as a flat string map ready to be the value of an input's
// `params` field. Values:
//   reconnect                   — "1": reconnect on EOF/errors at all.
//   reconnect_on_network_error  — "1": also reconnect on a network-level error,
//                                 which is what a dropped source read is.
//   reconnect_delay_max         — "30" seconds: ceiling on the exponential
//                                 backoff between reconnect attempts.
//   rw_timeout                  — "10000000" MICROSECONDS (= 10 s): the read
//                                 deadline, after which the read fails and the
//                                 reconnect logic takes over. The unit is
//                                 microseconds (ffmpeg's URLContext option), so
//                                 this is seconds-scale, not ~3 hours.
// A dropped read therefore recovers from the same byte offset, or fails fast
// after a bounded number of bounded attempts, instead of hanging.
export const DEFAULT_ENCORE_INPUT_RECONNECT_DELAY_MAX_SECONDS = 30;
export const DEFAULT_ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS = 10_000_000;

// Schemes that open a network protocol in ffmpeg once the transcoder has
// resolved them (see note 3 above). Same set as `ParsedSource['scheme']`
// (src/pipeline/source.ts:34).
const NETWORK_SCHEMES = new Set(['http:', 'https:', 's3:']);

// Is this input URI read over the network? Anything we cannot parse, or that
// parses to a non-network scheme (a bare path, `file:`), is treated as local and
// gets no params — see the note above on why a non-applicable input option is
// fatal to ffmpeg.
export function isNetworkInputUri(uri: string): boolean {
  let scheme: string;
  try {
    scheme = new URL(uri).protocol.toLowerCase();
  } catch {
    return false;
  }
  return NETWORK_SCHEMES.has(scheme);
}

// 12-factor overrides (config via env, no redeploy needed to retune). Mirrors
// the env-read helpers already used for the other pipeline tunables
// (`deliveryTimeoutMs`, src/pipeline/asset-delivery.ts:139-146;
// `rewrapUrlTtlSeconds`, src/pipeline/rewrap.ts:52-58): unset, unparseable or
// non-positive falls back to the default rather than disabling the bound.
//
// FLOOR BEFORE VALIDATING, not after. These values are emitted verbatim as
// ffmpeg option strings, and ffmpeg reads them as integers, so a fractional
// override has to be truncated. Validating first and truncating second let a
// sub-1 fraction through the guard and then floored it to 0 — `rw_timeout: "0"`
// and `reconnect_delay_max: "0"` — i.e. the exact "bound disabled" outcome the
// guard exists to prevent (ffmpeg treats rw_timeout 0 as no timeout). So the
// value that is actually emitted is the value that must satisfy `> 0`: floor
// first, then validate, and a floored 0 falls back to the default.
function positiveIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// Escape hatch: `ENCORE_INPUT_RECONNECT_ENABLED=false` submits inputs with no
// params at all (pre-#1222 behaviour), for an operator who needs to rule these
// params out while diagnosing something else. Any other value — including
// unset — keeps them on, so the recovering behaviour is the DEFAULT.
export function encoreInputReconnectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['ENCORE_INPUT_RECONNECT_ENABLED']?.trim().toLowerCase() !== 'false';
}

// The params to set on a transcoder job input reading `uri`, or undefined when
// none apply (local input, or disabled by config). Undefined is the signal to
// omit the `params` key entirely so the transcoder keeps its own `{}` default
// (Input.kt:217) — the same omit-when-absent rule `profileParams` follows.
export function encoreInputParamsFor(
  uri: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> | undefined {
  if (!isNetworkInputUri(uri)) return undefined;
  if (!encoreInputReconnectEnabled(env)) return undefined;
  const delayMaxSeconds = positiveIntEnv(
    env,
    'ENCORE_INPUT_RECONNECT_DELAY_MAX_SECONDS',
    DEFAULT_ENCORE_INPUT_RECONNECT_DELAY_MAX_SECONDS
  );
  const rwTimeoutMicroseconds = positiveIntEnv(
    env,
    'ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS',
    DEFAULT_ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS
  );
  return {
    reconnect: '1',
    reconnect_on_network_error: '1',
    reconnect_delay_max: String(delayMaxSeconds),
    rw_timeout: String(rwTimeoutMicroseconds)
  };
}
