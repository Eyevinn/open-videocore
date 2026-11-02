// Level-safe ladder fitting for H.264 encode profiles (issue #1167).
//
// THE BUG. The default `program` ladder declares each rung by HEIGHT only
// (`height: 1080`, `height: 720`, ...) together with a hardcoded H.264 `level`
// (`level: 4.1` on the 1080 rung, `level: 3.1` on the rest). With only a height,
// the transcoding service emits `scale=-2:<height>`, i.e. the output WIDTH is
// derived from the SOURCE aspect ratio. That is fine for an exactly-16:9 source
// (1920x1080 -> 120x68 = 8160 macroblocks, inside level 4.1's 8192 MB frame
// limit) but overflows for a source that is only APPROXIMATELY 16:9: an
// 854x480 source (854/480 = 1.7792, not 1.7778) scaled to height 1080 becomes
// 1922x1080 -> 121x68 = 8228 MB, above level 4.1's limit, and the decoded
// picture buffer with `ref: 4` becomes 4 x 8228 = 32912 MB, above the 32768 MB
// limit. libx264 then warns, and the warning is FATAL downstream (see contract
// C3 below), so the whole job fails as not-retryable. The 720 rung overflows
// the same way (1282x720 -> 81x45 = 3645 MB > level 3.1's 3600 MB).
//
// THE FIX. Give every such rung an explicit WIDTH as well, so the rung becomes
// a BOUNDING BOX rather than a height-only scale: with both dimensions present
// the transcoding service emits
// `scale=W:H:force_original_aspect_ratio=decrease:force_divisible_by=2`
// (contract C1), which preserves the source aspect ratio and can only ever
// shrink the output to fit inside the box. The box width is DERIVED, not
// guessed:
//   - the rung's nominal 16:9 width for its height (the ladder's own intent:
//     1080 -> 1920, 720 -> 1280, 540 -> 960, 360 -> 640, 234 -> 416), capped by
//   - the widest frame the rung's DECLARED level actually permits at that
//     height, computed from the H.264 Table A-1 limits MaxFS (frame size in
//     macroblocks) and MaxDpbMbs (decoded picture buffer in macroblocks) and the
//     rung's reference-frame count (contract C2).
// So the level a profile declares is honoured instead of being overflowed, the
// 16:9 sources that work today produce byte-identical geometry (1920x1080 ...),
// and a non-16:9 source is fitted inside the same box (854x480 -> 1920x1078)
// instead of busting the level.
//
// This module is PURE TEXT -> TEXT plus pure arithmetic. It never touches a
// rung that already declares a width, or one that declares no numeric height,
// or one whose height is a SpEL expression, so re-running it is a no-op
// (idempotent) and an operator profile that already states its own geometry is
// left exactly as authored.
//
// CONTRACT SOURCES (CLAUDE.md rule 7), all fetched 2026-10-19:
//   C1. Upstream transcoding service (github.com/svt/encore, branch master) —
//       `encore-common/src/main/kotlin/se/svt/oss/encore/model/profile/VideoEncode.kt`,
//       `interface VideoEncode { val width: Int?; val height: Int?; ... }` and
//       `fun videoFilter(...)`:
//         if (scaleToWidth != null && scaleToHeight != null) {
//           videoFilters.add("scale=$scaleToWidth:$scaleToHeight:force_original_aspect_ratio=decrease:force_divisible_by=2")
//           videoFilters.add("setsar=1/1")
//         } else if (scaleToWidth != null || scaleToHeight != null) {
//           videoFilters.add("scale=${scaleToWidth ?: -2}:${scaleToHeight ?: -2}")
//         }
//       — i.e. width+height = fit-inside-box (aspect preserved, even
//       dimensions, square pixels); height alone = `scale=-2:H` (width from the
//       source aspect ratio). This is the exact behaviour this module relies on.
//       `encore-common/.../model/profile/X264Encode.kt` confirms the YAML field
//       names on the rung itself: `data class X264Encode(override val width:
//       Int?, override val height: Int?, ... @JsonProperty("params")
//       override val ffmpegParams, @JsonProperty("x264-params") override val
//       codecParams, ...)` — so `width:`/`height:` are rung-level keys, `level`
//       lives under `params:` and `ref` under `x264-params:`.
//   C2. H.264 Annex A Table A-1 level limits, as tabulated by FFmpeg (the
//       encoder this profile drives) in `libavcodec/h264_levels.c`,
//       `static const H264LevelDescriptor h264_levels[]` — columns
//       `Name, level_idc, cs3f, MaxMBPS, MaxFS, MaxDpbMbs, MaxBR, MaxCPB,
//       MaxVmvR, MaxMvsPer2Mb, MinCR`. MaxFS/MaxDpbMbs below are copied from
//       that table verbatim (e.g. "3.1" -> 3600 / 18000, "4.1" -> 8192 / 32768,
//       "4.2" -> 8704 / 34816).
//   C3. Why the warning is fatal:
//       `encore-common/src/main/kotlin/se/svt/oss/encore/service/FfmpegExecutor.kt`
//       — in the ffmpeg output loop, `"warning" -> { ... if
//       (line.contains("DPB size")) { errorLines.add(line); throw
//       RuntimeException("Coding might not be compatible on all devices:\n...") } }`.
//       A single DPB-size warning line aborts the encode, which is why a level
//       overflow surfaces as a hard, deterministic job failure rather than a
//       warning in the log.
//   C4. The ladder being fixed: the seeded default profile index
//       (ENCORE_PROFILES_URL, src/main.ts) ->
//       Eyevinn/encore-test-profiles `program.yml` (branch main), whose five
//       X264Encode rungs declare `height: 1080|720|540|360|234`, no `width`,
//       `params.level: 4.1|3.1|3.1|3.1|3.1` and `x264-params.ref: 4|4|4|4|3`.
//   C5. The portrait transpose `predictScaledOutput` models (fetched 2026-10-19
//       via the GitHub contents API, svt/encore default branch) —
//       `encore-common/src/main/kotlin/se/svt/oss/encore/model/profile/VideoEncode.kt`,
//       `fun videoFilter(...)`, the lines immediately BEFORE the scale filter:
//         val outputDar = (padTo ?: cropTo ?: videoInput.padTo ?: videoInput.cropTo)?.toFractionOrNull()
//           ?: (videoStream.displayAspectRatio?.toFractionOrNull() ?: Fraction(videoStream.width, videoStream.height))
//             .let { if (isRotated90) it.reciprocal() else it }
//         val outputIsPortrait = outputDar < Fraction.ONE
//         val isScalingWithinLandscape =
//           scaleToWidth != null && scaleToHeight != null && Fraction(scaleToWidth, scaleToHeight) > Fraction.ONE
//         if (encodingProperties.flipWidthHeightIfPortrait && outputIsPortrait && isScalingWithinLandscape) {
//           scaleToWidth = height; scaleToHeight = width
//         }
//       and `encore-common/src/main/kotlin/se/svt/oss/encore/config/EncodingProperties.kt`:
//       `val flipWidthHeightIfPortrait: Boolean = true` — the flag is ON by
//       default, so a portrait source against a landscape box is fitted into the
//       TRANSPOSED box (HxW). This does not affect the bounding width the fit
//       computes (the macroblock bound of a box is transpose-invariant), only the
//       geometry a caller predicts.

// Macroblock edge in pixels for H.264 (16x16 luma samples). Frame size limits in
// Table A-1 are expressed in these units.
const MB_SIZE = 16;

// Reference-frame count assumed when a rung declares no explicit `ref`. libx264
// derives its own refs from the preset in that case; 4 is the value the seeded
// ladders use and is the conservative choice for the DPB budget (a larger
// assumed DPB yields a SMALLER permitted frame, never a level overflow).
const DEFAULT_REF_FRAMES = 4;

export type H264LevelLimits = {
  // Level as written in a profile (`4.1`), i.e. the ffmpeg `level` param value.
  level: string;
  // level_idc (41 for level 4.1) — accepted as an alternative spelling.
  levelIdc: number;
  // MaxFS: maximum frame size in macroblocks.
  maxFrameSizeMbs: number;
  // MaxDpbMbs: maximum decoded picture buffer size in macroblocks.
  maxDpbMbs: number;
};

// H.264 Table A-1, MaxFS + MaxDpbMbs columns only (contract C2). Order follows
// the FFmpeg table. "1b" is spelled with both of its level_idc encodings there;
// only the canonical (11/cs3f) pairing is relevant to a profile's `level` value,
// so it is listed once.
export const H264_LEVEL_LIMITS: readonly H264LevelLimits[] = [
  { level: '1', levelIdc: 10, maxFrameSizeMbs: 99, maxDpbMbs: 396 },
  { level: '1b', levelIdc: 9, maxFrameSizeMbs: 99, maxDpbMbs: 396 },
  { level: '1.1', levelIdc: 11, maxFrameSizeMbs: 396, maxDpbMbs: 900 },
  { level: '1.2', levelIdc: 12, maxFrameSizeMbs: 396, maxDpbMbs: 2376 },
  { level: '1.3', levelIdc: 13, maxFrameSizeMbs: 396, maxDpbMbs: 2376 },
  { level: '2', levelIdc: 20, maxFrameSizeMbs: 396, maxDpbMbs: 2376 },
  { level: '2.1', levelIdc: 21, maxFrameSizeMbs: 792, maxDpbMbs: 4752 },
  { level: '2.2', levelIdc: 22, maxFrameSizeMbs: 1620, maxDpbMbs: 8100 },
  { level: '3', levelIdc: 30, maxFrameSizeMbs: 1620, maxDpbMbs: 8100 },
  { level: '3.1', levelIdc: 31, maxFrameSizeMbs: 3600, maxDpbMbs: 18000 },
  { level: '3.2', levelIdc: 32, maxFrameSizeMbs: 5120, maxDpbMbs: 20480 },
  { level: '4', levelIdc: 40, maxFrameSizeMbs: 8192, maxDpbMbs: 32768 },
  { level: '4.1', levelIdc: 41, maxFrameSizeMbs: 8192, maxDpbMbs: 32768 },
  { level: '4.2', levelIdc: 42, maxFrameSizeMbs: 8704, maxDpbMbs: 34816 },
  { level: '5', levelIdc: 50, maxFrameSizeMbs: 22080, maxDpbMbs: 110400 },
  { level: '5.1', levelIdc: 51, maxFrameSizeMbs: 36864, maxDpbMbs: 184320 },
  { level: '5.2', levelIdc: 52, maxFrameSizeMbs: 36864, maxDpbMbs: 184320 },
  { level: '6', levelIdc: 60, maxFrameSizeMbs: 139264, maxDpbMbs: 696320 },
  { level: '6.1', levelIdc: 61, maxFrameSizeMbs: 139264, maxDpbMbs: 696320 },
  { level: '6.2', levelIdc: 62, maxFrameSizeMbs: 139264, maxDpbMbs: 696320 }
];

// Resolve a `level` value as written in a profile to its Table A-1 limits.
// Accepts the dotted spelling ffmpeg/libx264 use (`4.1`, `"4.1"`, `4`), the
// level_idc spelling (`41`), and `1b`. Returns undefined for anything else
// (including a SpEL expression), which callers treat as "leave this rung
// alone".
export function lookupH264Level(value: string | undefined): H264LevelLimits | undefined {
  if (value === undefined) return undefined;
  const raw = value.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (raw.length === 0) return undefined;
  const byName = H264_LEVEL_LIMITS.find((l) => l.level === raw);
  if (byName) return byName;
  // A bare integer is ambiguous: `4` is level 4.0 while `41` is level_idc 41.
  // Table A-1 level names are 1..6 (and the `1b` special case), so a value of
  // 10 or more can only be a level_idc.
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n >= 10) {
      const byIdc = H264_LEVEL_LIMITS.find((l) => l.levelIdc === n);
      if (byIdc) return byIdc;
    }
  }
  // Trailing-zero spellings such as `4.0` / `3.0`.
  const trimmed = raw.replace(/\.0$/, '');
  return H264_LEVEL_LIMITS.find((l) => l.level === trimmed);
}

// Macroblock count of a frame: ceil(w/16) * ceil(h/16) (contract C2 units).
export function frameSizeMbs(width: number, height: number): number {
  return Math.ceil(width / MB_SIZE) * Math.ceil(height / MB_SIZE);
}

// The widest frame (in pixels, rounded down to a whole macroblock column) that
// `level` permits at `height`, accounting for BOTH limits that libx264 checks:
// the frame-size limit MaxFS and the decoded-picture-buffer limit MaxDpbMbs
// divided by the reference-frame count. Returns undefined when the level is
// unknown or the height is unusable; returns 0 when the level cannot carry even
// one macroblock column at that height (caller decides what to do).
export function maxLevelSafeWidth(input: {
  level: string | undefined;
  height: number;
  refFrames?: number;
}): number | undefined {
  const limits = lookupH264Level(input.level);
  if (!limits) return undefined;
  if (!Number.isFinite(input.height) || input.height <= 0) return undefined;
  const refFrames =
    input.refFrames !== undefined && input.refFrames > 0 ? input.refFrames : DEFAULT_REF_FRAMES;
  const rows = Math.ceil(input.height / MB_SIZE);
  const frameBudgetMbs = Math.min(
    limits.maxFrameSizeMbs,
    Math.floor(limits.maxDpbMbs / refFrames)
  );
  const columns = Math.floor(frameBudgetMbs / rows);
  return Math.max(0, columns) * MB_SIZE;
}

// The rung's nominal 16:9 width for its height, rounded to an even number of
// pixels (1080 -> 1920, 720 -> 1280, 540 -> 960, 360 -> 640, 234 -> 416). This
// is the ladder's own intent: a height-only rung is written for 16:9 material.
export function nominalSixteenNineWidth(height: number): number {
  const exact = (height * 16) / 9;
  const even = Math.round(exact / 2) * 2;
  return Math.max(2, even);
}

// Reproduce the output geometry the transcoding service will produce for a
// source, given a rung's box (contract C1): both dimensions present means
// `scale=W:H:force_original_aspect_ratio=decrease:force_divisible_by=2` (fit
// inside the box, aspect preserved, each dimension floored to a multiple of 2);
// height alone means `scale=-2:H` (width from the source aspect ratio, rounded
// to a multiple of 2). Used by the tests to assert a real source size lands
// inside its rung's level limits; exported so other call sites can predict the
// same geometry without duplicating the rule.
//
// PORTRAIT TRANSPOSE (contract C5). Before it emits the scale filter, the
// transcoding service TRANSPOSES a landscape box when the output is portrait, so
// a portrait source is fitted into HxW rather than letterboxed inside WxH. The
// branch is modelled here because without it the predicted geometry for a
// portrait source is wrong by construction (it predicted 606x1080 for a
// 1080x1920 source against the 1920x1080 box, a frame the encoder never emits).
// `flipWidthHeightIfPortrait` defaults to TRUE upstream, so that is the default
// here too; `opts.flipWidthHeightIfPortrait: false` models a deployment that
// turns the flag off.
//
// The transpose cannot change level safety: `frameSizeMbs` is
// ceil(w/16)*ceil(h/16), so a transposed box has exactly the same macroblock
// bound as the box the fit sized against. Only the predicted pixel geometry
// changes.
//
// `opts.displayAspectRatio` mirrors upstream's preference for the analyzed
// stream's DAR over its raw pixel dimensions (and is how a rotated source is
// expressed — upstream takes the reciprocal of the DAR for a 90-degree
// rotation). Omitted, the source's own width/height is the DAR, which is
// upstream's own fallback.
export function predictScaledOutput(
  source: { width: number; height: number },
  box: { width?: number; height?: number },
  opts?: {
    flipWidthHeightIfPortrait?: boolean;
    displayAspectRatio?: { width: number; height: number };
  }
): { width: number; height: number } {
  const floorEven = (v: number): number => Math.max(2, Math.floor(v / 2) * 2);
  const roundEven = (v: number): number => Math.max(2, Math.round(v / 2) * 2);
  if (box.width !== undefined && box.height !== undefined) {
    // Upstream, verbatim (contract C5):
    //   val outputIsPortrait = outputDar < Fraction.ONE
    //   val isScalingWithinLandscape = scaleToWidth != null && scaleToHeight != null &&
    //     Fraction(scaleToWidth, scaleToHeight) > Fraction.ONE
    //   if (encodingProperties.flipWidthHeightIfPortrait && outputIsPortrait &&
    //       isScalingWithinLandscape) { scaleToWidth = height; scaleToHeight = width }
    // Both comparisons are STRICT, so a square source (DAR 1) and a square box
    // are both left alone.
    const dar = opts?.displayAspectRatio ?? source;
    const outputIsPortrait = dar.height > 0 && dar.width / dar.height < 1;
    const isScalingWithinLandscape = box.width > box.height;
    const flip = opts?.flipWidthHeightIfPortrait ?? true;
    if (flip && outputIsPortrait && isScalingWithinLandscape) {
      return predictScaledOutput(source, { width: box.height, height: box.width }, {
        ...opts,
        // The transpose happens once; re-entering with the transposed (now
        // portrait) box must not flip it back.
        flipWidthHeightIfPortrait: false
      });
    }
    // ffmpeg's `scale` with force_original_aspect_ratio=decrease derives each
    // dimension from the OTHER box dimension by integer rescale and then takes
    // the smaller of that and the box dimension
    // (libavfilter/vf_scale.c: tmp_w = av_rescale(h, iw, ih);
    //  tmp_h = av_rescale(w, ih, iw); w = FFMIN(tmp_w, w); h = FFMIN(tmp_h, h)),
    // before rounding down to force_divisible_by. Modelled the same way here so
    // the predicted geometry matches the encoder's to the pixel rather than
    // drifting by a rounding step.
    const widthFromBoxHeight = Math.round((box.height * source.width) / source.height);
    const heightFromBoxWidth = Math.round((box.width * source.height) / source.width);
    return {
      width: floorEven(Math.min(widthFromBoxHeight, box.width)),
      height: floorEven(Math.min(heightFromBoxWidth, box.height))
    };
  }
  if (box.height !== undefined) {
    return {
      width: roundEven(source.width * (box.height / source.height)),
      height: box.height
    };
  }
  if (box.width !== undefined) {
    return {
      width: box.width,
      height: roundEven(source.height * (box.width / source.width))
    };
  }
  return { width: source.width, height: source.height };
}

// One rung the fit changed, for logging and tests.
export type LadderFitAdjustment = {
  // The rung's `suffix` when it has one (`_x264_3100`), else undefined.
  suffix?: string;
  // The rung's declared height.
  height: number;
  // The rung's declared level, verbatim.
  level: string;
  // The bounding width added to the rung.
  width: number;
  // true when the declared level — not the nominal 16:9 geometry — is what
  // constrained the width, i.e. the profile declares a level too low for its own
  // rung height and the box is narrower than 16:9.
  levelConstrained: boolean;
};

export type LadderFitResult = {
  // The profile YAML with bounding widths added. Byte-identical to the input
  // when nothing needed fitting.
  yaml: string;
  changed: boolean;
  adjustments: LadderFitAdjustment[];
};

// Read one `key: value` from a text block at ANY indentation. Returns the first
// match, with surrounding quotes stripped. Mirrors the reader in
// src/pipeline/profile-colour-guard.ts (`readParam`) so the two guards parse
// profile YAML the same way.
function readParam(block: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, 'im');
  const m = re.exec(block);
  if (!m) return undefined;
  let value = m[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

// Where each `encodes:` list item starts, i.e. a `- type: X` line. The column
// `type` starts at is the item's own field indentation, which is how we tell a
// rung-level key (`height`) from a key nested under `params:` or `audioEncode:`.
const ENCODE_ITEM_START = /^(\s*)-(\s+)type\s*:/i;

// Add a bounding WIDTH to every video rung that declares a numeric `height`, an
// H.264 `level`, and no `width` — see the module header for why. Everything else
// in the document (comments, key order, unrelated rungs, audio/thumbnail
// encodes) is preserved byte-for-byte, and a document with nothing to fit comes
// back unchanged.
export function fitProfileLadderToLevel(yaml: string): LadderFitResult {
  const lines = yaml.split('\n');

  // Index the encode list items: start line and field indentation.
  type Item = { start: number; end: number; fieldIndent: number };
  const items: Item[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = ENCODE_ITEM_START.exec(lines[i]);
    if (!m) continue;
    const fieldIndent = m[1].length + 1 + m[2].length;
    if (items.length > 0) items[items.length - 1].end = i - 1;
    items.push({ start: i, end: lines.length - 1, fieldIndent });
  }

  const adjustments: LadderFitAdjustment[] = [];
  // Line index -> the width line to insert immediately after it.
  const insertions = new Map<number, string>();

  for (const item of items) {
    const blockLines = lines.slice(item.start, item.end + 1);
    const block = blockLines.join('\n');

    // Rung-level keys only: exactly `fieldIndent` spaces of indentation. The
    // first list line carries `type` at that column, and a nested map
    // (`params:`, `audioEncode:`) is indented deeper, so this ignores an
    // `audioEncode`'s own keys.
    const rungKey = (key: string): { index: number; value: string } | undefined => {
      const re = new RegExp(`^ {${item.fieldIndent}}${key}\\s*:\\s*(.*)$`);
      for (let i = 0; i < blockLines.length; i += 1) {
        const m = re.exec(blockLines[i]);
        if (m) return { index: item.start + i, value: m[1].trim() };
      }
      return undefined;
    };

    // A rung that already states its width is left alone (idempotency, and an
    // operator's explicit geometry is never second-guessed).
    if (rungKey('width')) continue;

    const heightKey = rungKey('height');
    if (!heightKey) continue;
    // A SpEL-parametrised or otherwise non-numeric height cannot be fitted
    // statically — leave it alone (e.g. `height: #{profileParams['height']?:1080}`).
    if (!/^\d+$/.test(heightKey.value)) continue;
    const height = Number(heightKey.value);
    if (height <= 0) continue;

    // `level` lives under the rung's `params:` map, `ref` under `x264-params:` /
    // `x265-params:`; neither key appears anywhere else in a rung, so reading
    // them from the whole block is unambiguous.
    const level = readParam(block, 'level');
    const limits = lookupH264Level(level);
    // No declared level means libx264 derives one from the actual frame — that
    // is already safe, so there is nothing to fit.
    if (!limits || level === undefined) continue;

    const refRaw = readParam(block, 'ref');
    const refFrames = refRaw !== undefined && /^\d+$/.test(refRaw) ? Number(refRaw) : undefined;

    const levelWidth = maxLevelSafeWidth({ level, height, refFrames });
    if (levelWidth === undefined || levelWidth <= 0) continue;
    const nominalWidth = nominalSixteenNineWidth(height);
    const width = Math.min(nominalWidth, levelWidth);

    insertions.set(heightKey.index, `${' '.repeat(item.fieldIndent)}width: ${width}`);
    const suffix = rungKey('suffix')?.value;
    adjustments.push({
      ...(suffix !== undefined && suffix.length > 0 ? { suffix } : {}),
      height,
      level,
      width,
      levelConstrained: levelWidth < nominalWidth
    });
  }

  if (insertions.size === 0) {
    return { yaml, changed: false, adjustments: [] };
  }

  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const insertion = insertions.get(i);
    // The width goes immediately BEFORE the height it bounds, so the rung reads
    // `width: 1920` / `height: 1080`.
    if (insertion !== undefined) out.push(insertion);
    out.push(lines[i]);
  }
  return { yaml: out.join('\n'), changed: true, adjustments };
}

// The level-safe form of a profile for the READ/PUBLISH path (issue #1167
// review, findings 2 + 3).
//
// WHY THE READ PATH. Fitting only on the bootstrap paths left two holes: a
// bootstrap that rewrote a stored ladder did not always refresh the object-store
// mirror the encoder actually reads, and `POST`/`PUT /api/v1/profiles` stored
// whatever the operator sent — so an unfitted height-only rung with a declared
// level could be authored (or re-authored) at any time and reproduce the bug
// until the next bootstrap silently rewrote it. Fitting at the point a profile
// is HANDED TO THE ENCODER instead makes the guarantee unconditional and leaves
// the stored document exactly as the operator wrote it: the management views
// (`GET /api/v1/profiles`, `GET /api/v1/profiles/:name`) still return the
// authored YAML, while the two surfaces the encoder consumes — the per-profile
// YAML document and the published object-store mirror — are always level-safe.
//
// Never throws: a profile this parser cannot handle is served verbatim, i.e.
// exactly the pre-fix behaviour, because a derived guard must not be able to
// take a profile read out.
export function levelSafeProfileYaml(yaml: string): string {
  try {
    return fitProfileLadderToLevel(yaml).yaml;
  } catch {
    return yaml;
  }
}
