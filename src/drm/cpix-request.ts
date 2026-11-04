// CPIX 2.3 / SPEKE key-request document builder (ADR-008 §6 "Request shape",
// §11 item 1; issue #1260).
//
// OWN CODE, NO XML LIBRARY (ADR-008 §11 item 1: "Request building is own code —
// a small, fully controlled template with escaped values; no library is needed
// to emit XML we define"). Only escaped template strings are used here. The
// RESPONSE parser is a different problem (untrusted input) and gets a vetted
// parser in its own ticket — nothing in this file parses XML.
//
// CONTRACT SOURCES (contract-first, CLAUDE.md rule 7). Every element name,
// attribute name, attribute value and child order below was read off a fetched
// contract in this session; none is from memory:
//
//   X1. CPIX 2.3 XML schema — `Dash-Industry-Forum/CPIX@master`
//       `XmlSchema/cpix.xsd` (fetched 2026-11-04):
//        - target namespace `urn:dashif:org:cpix`, `elementFormDefault="qualified"`,
//          `attributeFormDefault="unqualified"` (cpix.xsd:2) — so every element
//          is prefixed and no attribute is;
//        - root `<xs:element name="CPIX" type="cpix:CpixType"/>` (cpix.xsd:199);
//          `CpixType` attributes `id` (xs:ID), `contentId` (xs:string), `name`,
//          `version` (cpix.xsd:194-197);
//        - `CpixType` child SEQUENCE — DeliveryDataList, ContentKeyList,
//          DRMSystemList, ContentKeyPeriodList, ContentKeyUsageRuleList,
//          UpdateHistoryItemList, ds:Signature (cpix.xsd:185-193). The order
//          below is that sequence, not a preference;
//        - `ContentKeyType`: `@kid` REQUIRED `cpix:UUIDType`, `@contentId`,
//          `@explicitIV`, `@commonEncryptionScheme` optional (cpix.xsd:142-147);
//        - `DRMSystemType`: `@systemId` and `@kid` both REQUIRED
//          `cpix:UUIDType`; child sequence PSSH, ContentProtectionData,
//          HLSSignalingData{0,2}, SmoothStreamingProtectionHeaderData,
//          any##other (cpix.xsd:104-118);
//        - `ContentKeyUsageRuleType`: `@kid` REQUIRED, `@intendedTrackType`
//          optional; child sequence KeyPeriodFilter, LabelFilter, VideoFilter,
//          AudioFilter, BitrateFilter (cpix.xsd:52-64);
//        - `VideoFilterType`: `@minPixels`/`@maxPixels` xs:integer optional
//          (cpix.xsd:36-43); `AudioFilterType`: `@minChannels`/`@maxChannels`
//          (cpix.xsd:44-47);
//        - `UUIDType` restricts xs:string to hyphenated 8-4-4-4-12 hex
//          (cpix.xsd:6-10) — the shape `DRM_SYSTEM_ID_PATTERN`
//          (src/types/drm.ts) already encodes, reused here for `@kid`.
//
//   X2. SPEKE v2 request documents — the open source SPEKE reference key
//       server's own verification suite, `@HEAD`
//       `spekev2_verification_testsuite/spekev2_requests/vod/*.xml` (fetched
//       2026-11-04). The owning GitHub organisation is deliberately NOT named
//       here: it is the protocol originator's company name, and CLAUDE.md rule 1
//       admits no vendor name in any file, comments included. The paths and
//       file names are verbatim, so the source is still exactly locatable.
//       The v2 shape is taken verbatim from
//       `1_generic_...preset_video_1_audio_1_no_rotation.xml`: root attributes
//       `contentId` + `version="2.3"`, namespaces cpix/pskc/ds/enc and NO
//       others, `ContentKey@commonEncryptionScheme`, DRMSystem placeholder
//       children `PSSH`, `ContentProtectionData`, `HLSSignalingData
//       playlist="media"`, `HLSSignalingData playlist="master"`, and usage
//       rules with `@intendedTrackType="VIDEO"|"AUDIO"` + an empty
//       `VideoFilter`/`AudioFilter`. The single-key profile shape
//       (`@intendedTrackType="ALL"` with BOTH filters on one rule) is taken
//       from `2_speke_v1_style_implementation.xml` in the same directory.
//
//   X3. SPEKE v1 request document — same repository,
//       `tests/server_api_body.xml` (fetched 2026-11-04). The v1 shape is taken
//       verbatim from it: root attribute `id` (NOT `contentId`) and NO
//       `version`, `ContentKey` with `@kid` only, DRMSystem placeholder children
//       `ContentProtectionData`, `PSSH`, `URIExtXKey` (`URIExtXKey` is a CPIX
//       2.0/2.1 element that 2.3 replaced with `HLSSignalingData`, which is
//       exactly why it appears only on the v1 path), and usage rules WITHOUT
//       `@intendedTrackType`.
//
//   X4. XML name productions, for the two identifier guards below:
//        - `Namespaces in XML 1.1`, https://www.w3.org/TR/xml-names11/ (fetched
//          2026-11-04), production [4] `NCName ::= NCNameStartChar NCNameChar*`
//          ("An XML Name, minus the ':'"), [5] `NCNameChar ::= NameChar - ':'`,
//          [6] `NCNameStartChar ::= NameStartChar - ':'`;
//        - `XML Schema Part 2: Datatypes` §3.3.8 `ID`,
//          https://www.w3.org/TR/xmlschema-2/ (fetched 2026-11-04): "The value
//          space of ID is the set of all strings that match the NCName
//          production in [Namespaces in XML]" — so an `xs:ID` is an NCName and
//          in particular cannot start with a digit.
//
// NAMING (CLAUDE.md rule 1, ADR-008 §5.3). The v1 request documents of X3 also
// carry a vendor-namespaced extension (three placeholder elements in a company
// URN) that some v1 key servers use to return HLS key-format hints. That URN is
// a trademark-bearing string, so it is NOT hardcoded anywhere in this
// repository. It is reachable without a code change through
// `extensionNamespace` below, which an operator configures for their own
// provider — the same "configuration with a fallback override path" treatment
// ADR-008 §6 gives registered system ids. A system is likewise identified only
// by its registered system id (`DrmSystemId`), never a product name.

import { randomUUID } from 'node:crypto';

import { DRM_SYSTEM_ID_PATTERN, type TrackTypeGroup } from '../types/drm.js';
import type { KeyRequest } from './key-provider.js';

// Which wire dialect to emit. `'2.0'` is CPIX 2.3 (ADR-008 §6 "SPEKE v2 is CPIX
// 2.3"); `'1.0'` is the older attribute/element set, kept because several
// providers still default to it (ADR-008 §6 "SPEKE v1 fallback"). The values
// are the `StackConfig.drm.spekeVersion` values of ADR-008 §5.2.
export type SpekeVersion = '1.0' | '2.0';

// XML namespaces, from X1 (cpix.xsd:2, which declares all four) and X2 (which
// fixes the set a v2 request carries).
const NS_CPIX = 'urn:dashif:org:cpix';
const NS_PSKC = 'urn:ietf:params:xml:ns:keyprov:pskc';
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
const NS_ENC = 'http://www.w3.org/2001/04/xmlenc#';

// The CPIX version a SPEKE v2 request declares (X2: `version="2.3"`).
const CPIX_VERSION_SPEKE_V2 = '2.3';

// XML `NCName` (X4, production [4]), restricted to ASCII.
//
// A namespace prefix and an element's local name are NAMES, not text: they sit
// outside quotes, so attribute-value escaping cannot make an unsafe one safe —
// escaping `<` to `&lt;` inside a tag name would emit a document no parser
// accepts. A name that is not an NCName is therefore REJECTED, never escaped
// (the `validateExtensionNamespace` guard below). ASCII-only is deliberately
// NARROWER than the production, which admits Unicode letters: these names come
// from operator configuration in this repository's own deployment, and a
// narrower guard cannot admit something the production rejects.
const NCNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

// Prefixes the dialects bind themselves (see `buildCpixRequest`). An operator
// extension may not rebind one: two `xmlns:cpix` attributes on one element is
// not a well-formed document, and silently winning over `cpix` would redirect
// every element in the request to another namespace. `xml` and `xmlns` are
// reserved by Namespaces in XML (X4) and are NCNames, so the pattern alone does
// not catch them.
const RESERVED_NS_PREFIXES: readonly string[] = Object.freeze([
  'cpix',
  'pskc',
  'ds',
  'enc',
  'xml',
  'xmlns'
]);

// An operator-configured extension namespace whose empty placeholder elements
// are added to every `DRMSystem` on the SPEKE v1 path.
//
// WHY THIS IS CONFIGURATION AND NOT A CONSTANT: see the naming note in the file
// header. A v1 provider that needs its own placeholder children gets them by
// configuration; absent configuration, a request is pure CPIX, which is what
// the generic `cpix` adapter targets (ADR-008 D1).
export type CpixExtensionNamespace = {
  // Namespace prefix to bind, e.g. `ext`. MUST be an XML `NCName` (X4) and not
  // one of `RESERVED_NS_PREFIXES`; anything else is rejected by `validate`,
  // because a prefix is interpolated into a tag name where escaping is not an
  // available remedy.
  prefix: string;
  // Namespace URI to bind it to. A text value, so it is escaped, not rejected.
  uri: string;
  // Local names of the empty placeholder elements to emit inside each
  // `DRMSystem`, in the order given. Each MUST be an XML `NCName` (X4), for the
  // same reason as `prefix`.
  placeholderElements: readonly string[];
};

// Bounds for a `cpix:VideoFilter` (X1, cpix.xsd:36-43 — a PIXEL COUNT, i.e.
// width x height, not a dimension).
export type VideoPixelBounds = { minPixels?: number; maxPixels?: number };

// Default pixel bounds per video track group, overridable per stack.
//
// These only matter when MORE THAN ONE track group is requested: two video
// groups with identical (empty) filters would not tell the provider — or the
// packager — which key covers which tier, so each video rule must be bounded.
// The defaults are the standard raster of each tier as a pixel count
// (720x576 = 414720, 1920x1080 = 2073600, 3840x2160 = 8294400) with the bands
// made contiguous, so every ladder rung falls in exactly one group. An operator
// whose ladder draws the lines elsewhere overrides them via
// `CpixRequestOptions.videoPixelBounds` — no code change, same fallback
// treatment as the system ids.
export const DEFAULT_VIDEO_PIXEL_BOUNDS: Readonly<Partial<Record<TrackTypeGroup, VideoPixelBounds>>> =
  Object.freeze({
    SD: Object.freeze({ maxPixels: 414720 }),
    HD: Object.freeze({ minPixels: 414721, maxPixels: 2073600 }),
    UHD1: Object.freeze({ minPixels: 2073601, maxPixels: 8294400 })
  });

// Track groups that describe video. `AUDIO` is the only non-video group in
// `TRACK_TYPE_GROUPS` (src/types/drm.ts).
const VIDEO_TRACK_GROUPS: readonly TrackTypeGroup[] = Object.freeze(['SD', 'HD', 'UHD1']);

export type CpixRequestOptions = {
  spekeVersion: SpekeVersion;
  // SPEKE v1 only (ignored for v2, whose namespace set is fixed by X2).
  extensionNamespace?: CpixExtensionNamespace;
  // Overrides for `DEFAULT_VIDEO_PIXEL_BOUNDS`, per track group.
  videoPixelBounds?: Partial<Record<TrackTypeGroup, VideoPixelBounds>>;
  // Mints a key id for a track group `KeyRequest.keyIds` does not pin.
  // Injectable ONLY so the golden-file tests are deterministic; production
  // callers leave it unset and get `node:crypto` `randomUUID`.
  newKeyId?: () => string;
};

export type CpixRequest = {
  // The request document, ready to POST as `application/xml`.
  document: string;
  // The key id used for each requested track group — minted ones included.
  //
  // The caller MUST persist these (`AssetDrm.keyIds`, ADR-008 D4/§6): they are
  // what makes a re-package re-request the same keys instead of orphaning a
  // published manifest. Identifiers only; no key material (ADR-008 D4).
  keyIds: { trackGroup: TrackTypeGroup; keyId: string }[];
};

// Build a CPIX/SPEKE key-request document for one asset.
//
// Deterministic for a given input: same request + same pinned key ids => byte-
// identical document (this is what the golden-file tests rest on).
export function buildCpixRequest(req: KeyRequest, options: CpixRequestOptions): CpixRequest {
  validate(req, options);

  const mint = options.newKeyId ?? defaultNewKeyId;
  const v2 = options.spekeVersion === '2.0';

  // One key per track group (ADR-008 D3). `@kid` is REQUIRED by the schema
  // (X1, cpix.xsd:144) and both reference request documents (X2, X3) carry a
  // real UUID, so the REQUESTER mints any kid the caller has not pinned —
  // ADR-008 §6's "empty `@kid`" wording cannot be emitted without producing a
  // schema-invalid document.
  const keyIds = req.trackGroups.map((trackGroup) => {
    const pinned = req.keyIds?.[trackGroup];
    const keyId = pinned ?? mint();
    if (!DRM_SYSTEM_ID_PATTERN.test(keyId)) {
      // Same `cpix:UUIDType` shape as a system id (X1, cpix.xsd:6-10, used by
      // `@kid` at cpix.xsd:144). Caught here rather than at the provider.
      throw new Error(`cpix request: key id for track group ${trackGroup} is not a UUID`);
    }
    return { trackGroup, keyId };
  });

  const singleKeyProfile = keyIds.length === 1;
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];

  // Root. The content identifier attribute differs between the dialects: v2
  // uses `contentId` + `version` (X2), v1 uses `id` (X3).
  //
  // DELIBERATE SCHEMA DEVIATION ON THE V1 PATH, recorded the same way as the
  // `playlist="master"` deviation below. `CpixType/@id` is `xs:ID`
  // (X1, cpix.xsd:194), and an `xs:ID` is an NCName (X4, XML Schema Part 2
  // §3.3.8), which may not start with a digit — so a content id that is a ULID
  // (`01K9...`) makes the v1 root invalid against the letter of the schema.
  // The bare content id is emitted anyway, because the v1 WIRE FORMAT is what a
  // v1 key server matches on and it carries the bare id here:
  //   - the ticket defines the v1 output shape as `<cpix:CPIX id="<contentId>">`
  //     (issue #1260, "Output shape");
  //   - the verified v1 reference request document (X3) is itself
  //     `id="5E99137A-BD6C-4ECC-A24D-A3EE04B4E011"` — a bare content id whose
  //     own leading digit already violates `xs:ID`, i.e. the deployed dialect
  //     and the schema disagree here, not this builder and the schema.
  // Same resolution as `playlist`: the wire format wins, and the deviation is
  // written down instead of being silent. SPEKE v2 has no such problem — it
  // puts the content id in `@contentId` (`xs:string`, X1 cpix.xsd:195), and
  // that is the path a new deployment should use. Moving v1 to an NCName-safe
  // synthetic `@id` plus `@contentId` is a wire-format change (ADR-008 §6) and
  // belongs to the architect, not to this builder.
  const rootAttrs = v2
    ? [attr('contentId', req.contentId), attr('version', CPIX_VERSION_SPEKE_V2)]
    : [attr('id', req.contentId)];
  const namespaces = v2
    ? [ns('cpix', NS_CPIX), ns('pskc', NS_PSKC), ns('ds', NS_DS), ns('enc', NS_ENC)]
    : [ns('cpix', NS_CPIX), ns('pskc', NS_PSKC)];
  if (!v2 && options.extensionNamespace) {
    namespaces.push(ns(options.extensionNamespace.prefix, options.extensionNamespace.uri));
  }
  lines.push(`<cpix:CPIX ${[...rootAttrs, ...namespaces].join(' ')}>`);

  // 1. ContentKeyList — one empty ContentKey per track group, which is what
  //    asks the provider to mint the key for that kid (X1 cpix.xsd:187,
  //    X2/X3). `@commonEncryptionScheme` is a v2-path attribute (X2).
  lines.push('  <cpix:ContentKeyList>');
  for (const { keyId } of keyIds) {
    const a = [attr('kid', keyId)];
    if (v2) a.push(attr('commonEncryptionScheme', req.scheme));
    lines.push(`    <cpix:ContentKey ${a.join(' ')}/>`);
  }
  lines.push('  </cpix:ContentKeyList>');

  // 2. DRMSystemList — one DRMSystem per (kid, systemId) pair, each carrying
  //    the EMPTY placeholder children the provider fills in its response
  //    (X1 cpix.xsd:188, X2, X3). Child order and element set are the only
  //    other v1/v2 difference.
  lines.push('  <cpix:DRMSystemList>');
  for (const { keyId } of keyIds) {
    for (const systemId of req.systems) {
      lines.push(`    <cpix:DRMSystem ${attr('kid', keyId)} ${attr('systemId', systemId)}>`);
      if (v2) {
        lines.push('      <cpix:PSSH/>');
        lines.push('      <cpix:ContentProtectionData/>');
        // `playlist` values from X2 (the reference requests) and the suite's
        // own response assertions, which expect exactly one `media` and one
        // `master` element. NOTE: cpix.xsd:11-16 `PlaylistType` enumerates
        // `multiVariant`/`media`; the deployed SPEKE v2 wire format uses
        // `master` for the multivariant playlist. The wire format wins — it is
        // what a provider matches on.
        lines.push(`      <cpix:HLSSignalingData ${attr('playlist', 'media')}/>`);
        lines.push(`      <cpix:HLSSignalingData ${attr('playlist', 'master')}/>`);
      } else {
        lines.push('      <cpix:ContentProtectionData/>');
        for (const name of options.extensionNamespace?.placeholderElements ?? []) {
          // `prefix` and `name` are NCNames: `validateExtensionNamespace` (via
          // `validate` at the top of this function) rejected anything else, so
          // nothing XML-significant can reach a tag name here.
          lines.push(`      <${options.extensionNamespace!.prefix}:${name}/>`);
        }
        lines.push('      <cpix:PSSH/>');
        lines.push('      <cpix:URIExtXKey/>');
      }
      lines.push('    </cpix:DRMSystem>');
    }
  }
  lines.push('  </cpix:DRMSystemList>');

  // 3. ContentKeyUsageRuleList — binds each key to the tracks it covers
  //    (X1 cpix.xsd:190, ADR-008 §6). Single-key profile: ONE rule covering
  //    both media types (X2, `2_speke_v1_style_implementation.xml`).
  lines.push('  <cpix:ContentKeyUsageRuleList>');
  for (const { trackGroup, keyId } of keyIds) {
    const isVideo = VIDEO_TRACK_GROUPS.includes(trackGroup);
    const trackType = singleKeyProfile ? 'ALL' : isVideo ? 'VIDEO' : 'AUDIO';
    const ruleAttrs = [attr('kid', keyId)];
    // `@intendedTrackType` is a v2-path attribute: the verified v1 request
    // document (X3) carries no such attribute.
    if (v2) ruleAttrs.push(attr('intendedTrackType', trackType));
    lines.push(`    <cpix:ContentKeyUsageRule ${ruleAttrs.join(' ')}>`);
    if (singleKeyProfile) {
      lines.push('      <cpix:VideoFilter/>');
      lines.push('      <cpix:AudioFilter/>');
    } else if (isVideo) {
      const bounds = options.videoPixelBounds?.[trackGroup] ?? DEFAULT_VIDEO_PIXEL_BOUNDS[trackGroup];
      const filterAttrs: string[] = [];
      if (bounds?.minPixels !== undefined) filterAttrs.push(attr('minPixels', String(bounds.minPixels)));
      if (bounds?.maxPixels !== undefined) filterAttrs.push(attr('maxPixels', String(bounds.maxPixels)));
      lines.push(
        filterAttrs.length > 0
          ? `      <cpix:VideoFilter ${filterAttrs.join(' ')}/>`
          : '      <cpix:VideoFilter/>'
      );
    } else {
      lines.push('      <cpix:AudioFilter/>');
    }
    lines.push('    </cpix:ContentKeyUsageRule>');
  }
  lines.push('  </cpix:ContentKeyUsageRuleList>');

  lines.push('</cpix:CPIX>');
  // Trailing newline so the golden files are ordinary text files.
  return { document: `${lines.join('\n')}\n`, keyIds };
}

function validate(req: KeyRequest, options: CpixRequestOptions): void {
  if (req.contentId.length === 0) {
    throw new Error('cpix request: contentId is required');
  }
  if (req.systems.length === 0) {
    throw new Error('cpix request: at least one DRM system id is required');
  }
  for (const systemId of req.systems) {
    // `cpix:UUIDType`, X1 cpix.xsd:6-10/114. Rejected here so a misconfigured
    // system id never reaches a provider as a malformed document.
    if (!DRM_SYSTEM_ID_PATTERN.test(systemId)) {
      throw new Error('cpix request: system id is not a UUID');
    }
  }
  if (req.trackGroups.length === 0) {
    throw new Error('cpix request: at least one track group is required');
  }
  if (new Set(req.trackGroups).size !== req.trackGroups.length) {
    // One key per group (ADR-008 D3): a repeated group would emit two keys for
    // the same tracks and two rules the provider cannot disambiguate.
    throw new Error('cpix request: track groups must be unique');
  }
  if (options.extensionNamespace) {
    // Checked on both dialects even though only v1 emits the extension, so a
    // misconfigured namespace fails the same way whatever `spekeVersion` the
    // stack happens to be set to today.
    validateExtensionNamespace(options.extensionNamespace);
  }
  if (options.videoPixelBounds) {
    for (const [trackGroup, bounds] of Object.entries(options.videoPixelBounds)) {
      if (bounds) validateVideoPixelBounds(trackGroup, bounds);
    }
  }
}

// `prefix` and every placeholder local name are interpolated into TAG NAMES
// (`<prefix:Name/>`) and into an `xmlns:` attribute NAME, where escaping is not
// a remedy — so a name that is not an NCName (X4) is rejected outright.
function validateExtensionNamespace(extension: CpixExtensionNamespace): void {
  if (!NCNAME_PATTERN.test(extension.prefix)) {
    throw new Error('cpix request: extension namespace prefix is not an XML NCName');
  }
  if (RESERVED_NS_PREFIXES.includes(extension.prefix)) {
    throw new Error(
      `cpix request: extension namespace prefix "${extension.prefix}" is reserved`
    );
  }
  if (extension.uri.length === 0) {
    throw new Error('cpix request: extension namespace uri is required');
  }
  for (const name of extension.placeholderElements) {
    if (!NCNAME_PATTERN.test(name)) {
      throw new Error(
        'cpix request: extension placeholder element name is not an XML NCName'
      );
    }
  }
}

// `@minPixels`/`@maxPixels` are `xs:integer` (X1, cpix.xsd:36-43) and count
// pixels, so a negative, fractional, NaN/Infinity or precision-losing value
// cannot be serialised as one: `String(1e21)` is `"1e+21"` and `String(0.5)` is
// `"0.5"`, neither of which is an `xs:integer` lexical form. Rejected here so
// the builder cannot emit a document a provider will refuse.
function validateVideoPixelBounds(trackGroup: string, bounds: VideoPixelBounds): void {
  for (const [attribute, value] of [
    ['minPixels', bounds.minPixels],
    ['maxPixels', bounds.maxPixels]
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `cpix request: ${attribute} for track group ${trackGroup} must be a non-negative integer`
      );
    }
  }
  if (
    bounds.minPixels !== undefined &&
    bounds.maxPixels !== undefined &&
    bounds.minPixels > bounds.maxPixels
  ) {
    // An empty band would match no representation at all, so the key it binds
    // would cover nothing (ADR-008 §6: every rung falls in exactly one group).
    throw new Error(
      `cpix request: minPixels for track group ${trackGroup} exceeds maxPixels`
    );
  }
}

// Never reimplement crypto (ADR-008 §11): the platform UUID generator is the
// only source of minted key ids.
function defaultNewKeyId(): string {
  return randomUUID();
}

// XML attribute value escaping (own code, ADR-008 §11 item 1).
//
// Escapes the full set rather than the minimum: `&` and `<` are mandatory in an
// attribute value, `"` closes the value, and `>` / `'` are escaped too so the
// output is safe no matter which quoting or consumer sees it. `&` MUST be first
// or the replacements would double-escape each other.
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attr(name: string, value: string): string {
  return `${name}="${escapeXmlAttribute(value)}"`;
}

// `prefix` lands in an attribute NAME (`xmlns:<prefix>`), which escaping cannot
// protect — every caller passes either a constant of this file or a prefix
// `validateExtensionNamespace` has already accepted as an NCName. Only `uri`,
// the attribute VALUE, is escaped.
function ns(prefix: string, uri: string): string {
  return `xmlns:${prefix}="${escapeXmlAttribute(uri)}"`;
}
