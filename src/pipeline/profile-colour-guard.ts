// Profile colour-signalling carriability guard (issue #377).
//
// A profile can declare HDR colour signalling (PQ/HLG transfer, BT.2020
// primaries, HDR10 mastering metadata) while encoding at a pixel format that
// cannot physically carry it. When that happens the encode SUCCEEDS but the
// output is tagged as something it is not: e.g. an 8-bit stream tagged PQ, which
// a trusting player tone-maps as if it were HDR. During the Phase 1 encoding
// baseline, `x264-1080p-medium` produced exactly this (an 8-bit yuv420p stream
// tagged PQ) and the job reported success. Nothing in the pipeline noticed.
//
// This is a property of the PROFILE, not of the input, so — like the #286
// runnability guard (src/services/profile-runnability.ts) — we catch it at the
// point the profile is registered or selected, before an encode has been paid
// for, rather than after. Detection is content-based on the profile YAML so an
// operator-authored profile is checked the same way as a seeded one.
//
// The rules enforced (each is wrong regardless of intent):
//   1. transfer = smpte2084 (PQ) or arib-std-b67 (HLG) at an 8-bit pixel format.
//      Both PQ and HLG require at least 10-bit; 8-bit banding makes the signal
//      unusable and the tag a lie.
//   2. colorprim = bt2020 at an 8-bit pixel format — same reason.
//   3. HDR10 static mastering metadata (master-display, max-cll) present while
//      the transfer characteristic is NOT PQ. HDR10 mastering metadata only has
//      meaning alongside a PQ transfer.
//   4. master-display or max-cll set on an HLG output. HLG carries no mastering
//      metadata by design.
// The inverse — a 10-bit SDR output — is deliberately NOT an error: it is
// legitimate and common.
//
// CONTRACT SOURCE (CLAUDE.md rule 7):
//   - Profile YAML shape verified against the seeded Eyevinn/encore-test-profiles
//     (branch main, fetched 2026-08-22). Colour params live under each encode's
//     `params:` map, e.g. `pix_fmt: yuv420p` (program.yml, x264-1080p-medium.yml),
//     `pix_fmt: yuv420p10le` (program-x265.yml), `pix_fmt: yuv422p10le`
//     (archive.yml). x264/x265 HDR signalling params in that same map are
//     `transfer`, `colorprim`, `master-display`, `max-cll` (ffmpeg / libx26x
//     names). None of the currently-seeded profiles declare any colour tag, so
//     all pass; the guard protects future/operator profiles and the synthetic
//     8-bit-tagged-PQ negative control.
//   - Pattern follows src/services/profile-runnability.ts (isProfileRunnable /
//     isGpuOnlyProfileYaml) — content-based, returns a human-readable reason.

// Pixel formats mapped to their luma bit depth. EXPLICIT, not inferred: an
// unmapped/absent pix_fmt is treated as unknown (see pixelFormatBitDepth). The
// ffmpeg naming convention encodes depth via a `NNle`/`NNbe` suffix
// (yuv420p10le = 10-bit); the bare form (yuv420p) is 8-bit. This map lists the
// formats a profile in this store realistically emits plus the common HDR ones.
const PIXEL_FORMAT_BIT_DEPTH: Readonly<Record<string, number>> = {
  // 8-bit
  yuv420p: 8,
  yuvj420p: 8,
  yuv422p: 8,
  yuvj422p: 8,
  yuv444p: 8,
  yuvj444p: 8,
  nv12: 8,
  nv21: 8,
  gbrp: 8,
  rgb24: 8,
  bgr24: 8,
  // 10-bit
  yuv420p10le: 10,
  yuv420p10be: 10,
  yuv422p10le: 10,
  yuv422p10be: 10,
  yuv444p10le: 10,
  yuv444p10be: 10,
  p010le: 10,
  p010be: 10,
  gbrp10le: 10,
  gbrp10be: 10,
  // 12-bit
  yuv420p12le: 12,
  yuv420p12be: 12,
  yuv422p12le: 12,
  yuv422p12be: 12,
  yuv444p12le: 12,
  yuv444p12be: 12,
  gbrp12le: 12,
  gbrp12be: 12
};

// PQ and HLG transfer-characteristic aliases (ffmpeg / libx26x `transfer`
// values). Both require at least 10-bit.
const PQ_TRANSFERS = new Set(['smpte2084', 'smptest2084', 'pq']);
const HLG_TRANSFERS = new Set(['arib-std-b67', 'aribstdb67', 'hlg']);

// BT.2020 colour-primaries aliases (`colorprim` values).
const BT2020_PRIMARIES = new Set(['bt2020']);

// Minimum luma bit depth any wide-gamut / HDR transfer requires.
const MIN_HDR_BIT_DEPTH = 10;

// A single encode's colour-relevant params, extracted from its `params:` map.
type EncodeColourParams = {
  pixFmt?: string;
  transfer?: string;
  colorprim?: string;
  hasMasterDisplay: boolean;
  hasMaxCll: boolean;
};

export type ColourGuardResult =
  | { ok: true }
  | { ok: false; reason: string };

// Look up the explicit bit depth of a pixel format, or undefined when the
// format is unknown/absent. Case-insensitive.
export function pixelFormatBitDepth(pixFmt: string | undefined): number | undefined {
  if (!pixFmt) return undefined;
  return PIXEL_FORMAT_BIT_DEPTH[pixFmt.trim().toLowerCase()];
}

// Read one `key: value` param out of a params-block text region. Values may be
// quoted; surrounding quotes and whitespace are stripped. Returns undefined when
// the key is absent. The key is matched at any indentation (params live nested
// under `params:` in the YAML but we scan the whole encode block).
function readParam(block: string, key: string): string | undefined {
  // Escape regex metacharacters in the key (e.g. `master-display` has none, but
  // be safe for future keys).
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, 'im');
  const m = re.exec(block);
  if (!m) return undefined;
  let value = m[1].trim();
  // Strip a trailing inline comment that is clearly not part of a quoted value.
  // Strip matching surrounding quotes.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

// Split a profile YAML into per-encode text blocks. Each encode begins with a
// list item `- type: ...` at some indentation under `encodes:`. We split on the
// list-item boundary so params of one encode don't bleed into another. When no
// list items are found (a bare params fragment used in unit tests), the whole
// document is treated as a single block.
function splitEncodeBlocks(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] | null = null;
  const itemStart = /^(\s*)-\s+type\s*:/i;
  for (const line of lines) {
    if (itemStart.test(line)) {
      if (current) blocks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join('\n'));
  return blocks.length > 0 ? blocks : [yaml];
}

// Extract colour-relevant params from a single encode block.
function extractColourParams(block: string): EncodeColourParams {
  return {
    pixFmt: readParam(block, 'pix_fmt') ?? readParam(block, 'pixel_format'),
    transfer: readParam(block, 'transfer')?.toLowerCase(),
    colorprim: readParam(block, 'colorprim')?.toLowerCase(),
    hasMasterDisplay: readParam(block, 'master-display') !== undefined,
    hasMaxCll: readParam(block, 'max-cll') !== undefined
  };
}

// Validate one encode's colour signalling against its pixel format. Returns a
// human-readable reason on the first violation, or undefined when carriable.
function checkEncode(p: EncodeColourParams): string | undefined {
  const depth = pixelFormatBitDepth(p.pixFmt);
  const isPq = p.transfer !== undefined && PQ_TRANSFERS.has(p.transfer);
  const isHlg = p.transfer !== undefined && HLG_TRANSFERS.has(p.transfer);
  const isBt2020 = p.colorprim !== undefined && BT2020_PRIMARIES.has(p.colorprim);

  // Rule 1: PQ/HLG transfer at a known 8-bit (sub-10-bit) pixel format.
  if ((isPq || isHlg) && depth !== undefined && depth < MIN_HDR_BIT_DEPTH) {
    const label = isPq ? 'PQ (smpte2084)' : 'HLG (arib-std-b67)';
    return `transfer=${p.transfer} (${label}) is not carriable at pixel format ${p.pixFmt} (${depth}-bit); ${label} requires at least ${MIN_HDR_BIT_DEPTH}-bit`;
  }

  // Rule 2: BT.2020 primaries at a known 8-bit pixel format.
  if (isBt2020 && depth !== undefined && depth < MIN_HDR_BIT_DEPTH) {
    return `colorprim=${p.colorprim} (BT.2020) is not carriable at pixel format ${p.pixFmt} (${depth}-bit); wide-gamut BT.2020 requires at least ${MIN_HDR_BIT_DEPTH}-bit`;
  }

  // Rule 4: HDR10 mastering metadata on an HLG output. HLG carries no mastering
  // metadata by design. (Checked before rule 3 so HLG gets the specific
  // message rather than the generic non-PQ one.)
  if (isHlg && (p.hasMasterDisplay || p.hasMaxCll)) {
    const which = [p.hasMasterDisplay && 'master-display', p.hasMaxCll && 'max-cll']
      .filter(Boolean)
      .join(' and ');
    return `HDR10 mastering metadata (${which}) is set on an HLG output (transfer=${p.transfer}); HLG carries no mastering metadata by design`;
  }

  // Rule 3: HDR10 mastering metadata present while transfer is not PQ.
  if ((p.hasMasterDisplay || p.hasMaxCll) && !isPq) {
    const which = [p.hasMasterDisplay && 'master-display', p.hasMaxCll && 'max-cll']
      .filter(Boolean)
      .join(' and ');
    const transferClause = p.transfer
      ? `transfer=${p.transfer}`
      : 'no PQ transfer characteristic is set';
    return `HDR10 mastering metadata (${which}) is present but the transfer characteristic is not PQ (${transferClause}); HDR10 static metadata is only meaningful with transfer=smpte2084`;
  }

  return undefined;
}

// Validate a profile's colour signalling against the pixel format each of its
// encodes targets. Returns { ok: true } when every encode's colour signalling is
// carriable (including the legitimate 10-bit SDR and genuine HDR10/HLG cases),
// or { ok: false, reason } naming both offending values on the first violation.
export function validateProfileColourSignalling(profileYaml: string): ColourGuardResult {
  for (const block of splitEncodeBlocks(profileYaml)) {
    const reason = checkEncode(extractColourParams(block));
    if (reason) return { ok: false, reason };
  }
  return { ok: true };
}

// Convenience predicate mirroring isProfileRunnable (issue #286): true when the
// profile's colour signalling is carriable at its pixel format(s).
export function isProfileColourCarriable(profileYaml: string): boolean {
  return validateProfileColourSignalling(profileYaml).ok;
}
