// CPIX 2.3 / SPEKE key-RESPONSE parser (ADR-008 §6 "Response shape", §10 "XML
// parsing is a sensitive area", §11 item 4; issue #1261).
//
// This is the only place in the repository that parses untrusted XML. Input is
// a network peer's response body, so the rules are: size-capped BEFORE
// parsing, no DTD, no entity expansion, no namespace guessing, and no provider
// text in any error or log line (ADR-008 §10).
//
// CONTRACT SOURCES (contract-first, CLAUDE.md rule 7). Every element name,
// attribute name and namespace URI below was read off a contract fetched in
// this session; none is from memory:
//
//   R1. CPIX 2.3 XML schema — `Dash-Industry-Forum/CPIX@master`
//       `XmlSchema/cpix.xsd` (fetched 2026-11-04):
//        - target namespace `urn:dashif:org:cpix`, `elementFormDefault="qualified"`,
//          `attributeFormDefault="unqualified"` (cpix.xsd:2): every ELEMENT is
//          namespace-qualified, no ATTRIBUTE is — which is why `@kid`,
//          `@systemId`, `@playlist`, `@explicitIV` are read unprefixed below;
//        - root `<xs:element name="CPIX" type="cpix:CpixType"/>` (cpix.xsd:199);
//        - `ContentKeyType` (cpix.xsd:137-149): child sequence `HDCPData`,
//          `Data` of type `pskc:KeyDataType`; attributes `@kid`
//          (`cpix:UUIDType`, REQUIRED), `@explicitIV` (`xs:base64Binary`),
//          `@contentId`, `@commonEncryptionScheme`;
//        - `DRMSystemType` (cpix.xsd:104-118): child sequence `PSSH`
//          (`xs:base64Binary`), `ContentProtectionData`
//          (`cpix:ContentProtectionDataType`), `HLSSignalingData` 0..2
//          (`cpix:HLSSignalingDataType`), `SmoothStreamingProtectionHeaderData`,
//          `any##other`; attributes `@systemId` + `@kid` both REQUIRED
//          `cpix:UUIDType`;
//        - `HLSSignalingDataType` (cpix.xsd:89-96) and
//          `ContentProtectionDataType` (cpix.xsd:97-103) are
//          `xs:base64Binary` SIMPLE CONTENT with attributes (`@playlist`,
//          `@allowedCPC` / `@robustness`) — so their value is a TEXT node that
//          sits next to attributes, which is why `textOf()` below accepts both
//          a bare string and an object carrying `#text`;
//        - `CpixType` (cpix.xsd:185-198): `ContentKeyList`, `DRMSystemList`,
//          … and `@contentId`;
//        - `UUIDType` (cpix.xsd:6-10) — the hyphenated 8-4-4-4-12 hex shape
//          `DRM_SYSTEM_ID_PATTERN` (src/types/drm.ts) already encodes.
//
//   R2. PSKC schema — same repository, `XmlSchema/pskc.xsd` (fetched
//       2026-11-04): target namespace `urn:ietf:params:xml:ns:keyprov:pskc`,
//       `elementFormDefault="qualified"` (pskc.xsd:6-7);
//       `KeyDataType` child `Secret` of type `pskc:binaryDataType`
//       (pskc.xsd:83-87); `binaryDataType` is a CHOICE of `PlainValue`
//       (`xs:base64Binary`) or `EncryptedValue`, plus an optional `ValueMAC`
//       (pskc.xsd:100-110). So the key path is
//       `cpix:ContentKey/cpix:Data/pskc:Secret/pskc:PlainValue`, exactly as
//       ADR-008 §6 "Response shape" states.
//
//   R3. The open source SPEKE reference key server's own response builder,
//       `src/key_server_common.py@master` (fetched 2026-11-04) — the behaviour
//       of a real implementation, used to confirm what a RESPONSE actually
//       carries where the schema alone is ambiguous. The owning GitHub
//       organisation is deliberately not named (CLAUDE.md rule 1); the file
//       path is verbatim, so the source is still exactly locatable:
//        - `ContentKey` gains `{cpix}Data` -> `{pskc}Secret` ->
//          `{pskc}PlainValue` whose text is `base64(key_bytes)`
//          (key_server_common.py:205-229);
//        - `@explicitIV` is set to a BASE64 value (key_server_common.py:198,
//          :208-210) — which is why the base64 `@explicitIV` is re-encoded to
//          hex below to satisfy `ContentKey.iv` ("Hex", ADR-008 §5.1);
//        - `{cpix}URIExtXKey` text is `base64(<EXT-X-KEY URI>)`
//          (key_server_common.py:89, :97) — a UTF-8 URI, not binary, so it is
//          base64-DECODED into `DrmSignalling.hlsKeyUri`;
//        - `{cpix}PSSH` and `{cpix}ContentProtectionData` texts are base64 and
//          are passed through base64 (the `DrmSignalling` contract says "base64
//          PSSH box per system");
//        - `{cpix}HLSSignalingData[@playlist='media'|'master']` carry the two
//          HLS lines (key_server_common.py:296-299, :332-335).
//       `URIExtXKey` is NOT in the 2.3 schema (R1) — it is the CPIX 2.0/2.1
//       element that 2.3 replaced with `HLSSignalingData`, which is why it is
//       read opportunistically here and only ever appears on a SPEKE v1
//       response (same reasoning as the request builder, cpix-request.ts X3).
//
//   R4. `fast-xml-parser@4.5.7` API and option semantics — read from the
//       INSTALLED package, not from docs: `node_modules/fast-xml-parser/src/fxp.d.ts`
//       (`class XMLParser { constructor(options?: X2jOptions); parse(xmlData:
//       string | Uint8Array, validationOptions?): any }`, `X2jOptions`
//       members), `src/xmlparser/OptionsBuilder.js` (`defaultOptions` —
//       `ignoreAttributes: true`, `parseTagValue: true`, `attributeNamePrefix:
//       '@_'`, `textNodeName: '#text'`, `maxNestedTags: 100`; and
//       `normalizeProcessEntities`, which turns `processEntities: false` into
//       `{ enabled: false, … }`), `src/xmlparser/OrderedObjParser.js:473-492`
//       (`replaceEntitiesValue` returns the raw value unchanged when
//       `enabled` is false — i.e. NO entity is ever expanded) and
//       `src/xmlparser/DocTypeReader.js` (a DOCTYPE is still SCANNED even with
//       entity processing off, which is why this module refuses a document
//       containing one before the parser is ever called).
//
// NAMING (CLAUDE.md rule 1): no vendor, company or product name appears here. A
// DRM system is identified by its registered common-encryption system id.

import { DRM_SYSTEM_ID_PATTERN, type TrackTypeGroup } from '../types/drm.js';
import { KeyProviderError } from './key-provider-error.js';
import type { ContentKey, DrmSignalling, DrmSystemId } from './key-provider.js';

// XML namespace URIs (R1 cpix.xsd:2, R2 pskc.xsd:6).
export const NS_CPIX = 'urn:dashif:org:cpix';
export const NS_PSKC = 'urn:ietf:params:xml:ns:keyprov:pskc';

// Hard cap on a response body, applied BEFORE the parser is called
// (ADR-008 §10 "Bounded response size (256 KiB)", §11 item 4 "input capped at
// 256 KiB before parsing"). A CPIX response for a handful of keys and systems
// is a few kilobytes; 256 KiB is three orders of magnitude of headroom, and
// anything past it is not a key response.
export const MAX_CPIX_RESPONSE_BYTES = 256 * 1024;

// AES-128 content key length (ADR-008 §5.1 `ContentKey.key`: "16 bytes").
// A common-encryption content key is always 16 bytes, so a `PlainValue` that
// decodes to anything else is not a usable key and the response is invalid.
const CONTENT_KEY_BYTES = 16;

// Maximum element nesting accepted. A CPIX document nests at most
// CPIX > ContentKeyList > ContentKey > Data > Secret > PlainValue (6 levels,
// R1/R2), so 32 is generous while still bounding a pathologically deep
// document. `fast-xml-parser`'s own default is 100 (R4, OptionsBuilder.js).
const MAX_NESTED_TAGS = 32;

// The one error message the parser ever produces per failure kind. Fixed
// strings, written here — a provider's own bytes never reach a message
// (ADR-008 §10).
const INVALID = 'key provider returned an unusable CPIX response';

function invalidResponse(detail: string): KeyProviderError {
  // `detail` is always one of this module's OWN literals (see call sites), so
  // the surfaced message is entirely repository-authored text.
  return new KeyProviderError('key_provider_invalid_response', `${INVALID}: ${detail}`);
}

// What the caller asked for, and therefore what the response is checked
// against. The kid -> track group mapping is NOT in the response: CPIX binds a
// key to TRACKS (`ContentKeyUsageRule`), while the track GROUP is this
// repository's own vocabulary (ADR-008 §5.1), so the mapping comes from the
// request the caller just built (`CpixRequest.keyIds`, cpix-request.ts).
export type CpixResponseExpectation = {
  keyIds: readonly { trackGroup: TrackTypeGroup; keyId: string }[];
};

export type CpixResponseParseDeps = {
  // The XML -> object step, injectable ONLY so a test can prove the size and
  // DOCTYPE guards reject a hostile body WITHOUT the parser ever being
  // reached (the "rejected before parsing" acceptance criterion). Production
  // callers leave it unset and get the hardened parser below.
  parseXml?: (xml: string) => unknown;
};

// ---------------------------------------------------------------------------
// The hardened parser instance
// ---------------------------------------------------------------------------

// Every option here is load-bearing; the defaults it overrides are quoted from
// the installed `OptionsBuilder.js` `defaultOptions` (R4).
//
//   processEntities: false    ADR-008 §11 item 4. Normalised to
//                             `{ enabled: false }`, which makes
//                             `replaceEntitiesValue` a no-op (R4) — no
//                             internal, DOCTYPE or parameter entity is ever
//                             expanded, so an entity-expansion bomb cannot
//                             inflate. A DOCTYPE is refused outright before
//                             this parser runs (see `assertNoDoctype`).
//   ignoreDeclaration: true   ADR-008 §11 item 4. The `<?xml …?>` declaration
//                             is dropped rather than becoming a node.
//   ignorePiTags: true        Same reasoning for any other processing
//                             instruction: a key response has no use for one.
//   ignoreAttributes: false   DEFAULT IS `true` (R4) — with the default,
//                             `@kid` and `@systemId` would silently vanish and
//                             every response would look keyless.
//   parseTagValue: false      DEFAULT IS `true` (R4), i.e. text is run through
//                             `strnum`. A base64 key like "12345678" would
//                             become the NUMBER 12345678. Text stays text.
//   parseAttributeValue: false Same, for `@kid`/`@explicitIV` (already the
//                             default; set explicitly so a dependency bump
//                             cannot change it quietly).
//   trimValues: true          Base64 text is routinely pretty-printed with
//                             surrounding whitespace (R3's ElementTree output);
//                             trimming is what makes it decodable.
//   removeNSPrefix: false     The prefix is EVIDENCE: dropping it would make a
//                             document in the wrong namespace parse as if it
//                             were CPIX. Prefixes are resolved against the
//                             root's own `xmlns` declarations instead (see
//                             `resolvePrefixes`).
//   cdataPropName/commentPropName: false (default) — CDATA merges into the text
//                             value and comments are discarded; neither is a
//                             value this parser reads.
//   isArray                   `ContentKey`, `DRMSystem` and `HLSSignalingData`
//                             are repeatable (R1: maxOccurs unbounded /
//                             unbounded / 2). Without this a single occurrence
//                             is an object and two are an array, so every read
//                             site would need both shapes.
//   maxNestedTags             See `MAX_NESTED_TAGS`.
//   allowBooleanAttributes: false (default) — `<x y>` is not well-formed XML
//                             and a key server emitting it is not trustworthy.
//
// WHY `fast-xml-parser` IS PINNED TO EXACTLY `4.5.7` (package.json carries the
// exact version, not a range — and package.json is JSON, so the reasoning lives
// here, at the single import site, where a bump will be read):
//   - ADR-008 §11 item 3 is the decision: "`fast-xml-parser@4.5.7` (dist-tag
//     `legacy`) pulls ONE transitive dependency (`strnum`); the current
//     `5.11.2` line pulls SIX, several of them small single-purpose packages.
//     Decision: pin `fast-xml-parser@4.5.7` with the committed lockfile, review
//     the diff on any bump, and re-evaluate before moving to the 5.x line."
//   - Verified in the installed tree (2026-11-04):
//     `node_modules/fast-xml-parser/package.json` declares exactly
//     `"dependencies": { "strnum": "^1.0.5" }` — one transitive dependency, as
//     the ADR states.
//   - An exact version (no `^`) because this is a SECURITY-SENSITIVE parser on
//     an untrusted-input path (ADR-008 §10/§11 item 4): the hardening options
//     below are read off THIS version's `OptionsBuilder.js`/`OrderedObjParser.js`
//     (R4), so a silent minor bump could change an option's meaning — or its
//     default — under a parser whose configuration is the control.
//
// Imported lazily (inside the factory) so the dependency is only loaded by a
// process that actually parses a CPIX response.
let parserPromise: Promise<{ parse: (xml: string) => unknown }> | undefined;

async function hardenedParser(): Promise<{ parse: (xml: string) => unknown }> {
  if (!parserPromise) {
    parserPromise = import('fast-xml-parser').then(({ XMLParser }) => {
      const parser = new XMLParser({
        processEntities: false,
        ignoreDeclaration: true,
        ignorePiTags: true,
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '#text',
        parseTagValue: false,
        parseAttributeValue: false,
        trimValues: true,
        removeNSPrefix: false,
        allowBooleanAttributes: false,
        maxNestedTags: MAX_NESTED_TAGS,
        isArray: (name: string) =>
          name === 'ContentKey' || name === 'DRMSystem' || name === 'HLSSignalingData'
      });
      // `parse(xml, true)` runs `XMLValidator` FIRST and throws on a
      // not-well-formed document (R4: `parse(xmlData, validationOptions?:
      // validationOptions | boolean)`). Without the `true` the parser is
      // lenient — an unclosed root element yields a partial object rather than
      // an error, which would turn a truncated response into a silently
      // half-read one. The thrown message quotes the offending document, so
      // the caller discards it and surfaces its own text
      // (`key_provider_invalid_response`, ADR-008 §10).
      return { parse: (xml: string) => parser.parse(xml, true) as unknown };
    });
  }
  return parserPromise;
}

// ---------------------------------------------------------------------------
// Pre-parse guards (ADR-008 §10/§11 item 4)
// ---------------------------------------------------------------------------

// Byte size of a response body, which is what the 256 KiB cap is expressed in.
// `string.length` counts UTF-16 code units, not bytes, so it is NOT the cap.
export function cpixResponseByteLength(body: string): number {
  return Buffer.byteLength(body, 'utf8');
}

export function isCpixResponseTooLarge(
  body: string,
  maxBytes: number = MAX_CPIX_RESPONSE_BYTES
): boolean {
  return cpixResponseByteLength(body) > maxBytes;
}

// A document type declaration is refused, not tolerated. Entity EXPANSION is
// already off (`processEntities: false`), but `DocTypeReader` still scans a
// DOCTYPE to collect its entity definitions (R4), and a CPIX response has no
// legitimate reason to carry a DTD at all. Refusing it here means an entity
// bomb is rejected BEFORE the parser sees a byte of it.
//
// Matched as a plain substring on the exact XML spelling (`<!DOCTYPE` is
// case-sensitive in XML, as is `<!ENTITY`). A false positive would require a
// CPIX response whose base64 text or an attribute value contains that literal,
// which cannot happen in base64 — and refusing such a document is the safe
// direction anyway.
function assertNoDoctype(body: string): void {
  if (body.includes('<!DOCTYPE') || body.includes('<!ENTITY')) {
    throw invalidResponse('document type declarations are not accepted');
  }
}

// ---------------------------------------------------------------------------
// Namespace resolution
// ---------------------------------------------------------------------------

// `fast-xml-parser` does not resolve namespaces (R4: there is no such option —
// only `removeNSPrefix`, which DELETES the prefix). So prefixes are resolved
// here against the declarations on the ROOT element, which is where CPIX
// documents put them (both reference documents and R3's response builder
// declare `cpix`, `pskc`, `ds`, `enc` on the root and nowhere else).
//
// DELIBERATE LIMITATION, stated rather than hidden: a response that re-declares
// or shadows a prefix on a DESCENDANT element is not supported and is reported
// as `key_provider_invalid_response`. Implementing full scoped namespace
// resolution on top of a non-namespace-aware parse tree would be a second XML
// implementation inside this module — exactly what ADR-008 §11 item 2 says not
// to hand-roll. Nothing observed in the contracts emits one.
type Prefixes = {
  // Prefix bound to `urn:dashif:org:cpix`, '' for the default namespace.
  cpix: string;
  // Prefix bound to `urn:ietf:params:xml:ns:keyprov:pskc`, if declared.
  pskc: string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Local name of a (possibly prefixed) element key.
function localName(key: string): string {
  const colon = key.indexOf(':');
  return colon === -1 ? key : key.slice(colon + 1);
}

function prefixOf(key: string): string {
  const colon = key.indexOf(':');
  return colon === -1 ? '' : key.slice(0, colon);
}

// Find the document element: the single top-level key whose local name is
// `CPIX` (R1 cpix.xsd:199). Any other root — including a provider's HTML error
// page or a SOAP fault — is an invalid response.
function findRoot(doc: unknown): { key: string; node: Record<string, unknown> } {
  if (!isRecord(doc)) throw invalidResponse('response is not an XML document');
  for (const key of Object.keys(doc)) {
    if (localName(key) !== 'CPIX') continue;
    const node = doc[key];
    if (!isRecord(node)) throw invalidResponse('CPIX element is empty');
    return { key, node };
  }
  throw invalidResponse('no CPIX document element');
}

// Resolve the prefixes the ROOT binds, and REQUIRE that the document element is
// in the CPIX namespace. This is the check that makes a wrong-namespace
// document fail: a `<x:CPIX xmlns:x="urn:example:not-cpix">` parses perfectly
// and would otherwise be read as if it were CPIX.
function resolvePrefixes(rootKey: string, root: Record<string, unknown>): Prefixes {
  // Namespace declarations are ATTRIBUTES, so they arrive with the configured
  // `@_` prefix: `xmlns:cpix` -> `@_xmlns:cpix`, `xmlns` -> `@_xmlns`.
  let cpix: string | undefined;
  let pskc: string | undefined;
  for (const [attrKey, value] of Object.entries(root)) {
    if (!attrKey.startsWith('@_xmlns')) continue;
    if (typeof value !== 'string') continue;
    const declared = attrKey === '@_xmlns' ? '' : attrKey.slice('@_xmlns:'.length);
    if (value === NS_CPIX) cpix = declared;
    else if (value === NS_PSKC) pskc = declared;
  }
  if (cpix === undefined) {
    throw invalidResponse('document element is not in the CPIX namespace');
  }
  // The document element must itself be in the CPIX namespace — not merely in a
  // document that happens to declare it somewhere.
  if (prefixOf(rootKey) !== cpix) {
    throw invalidResponse('document element is not in the CPIX namespace');
  }
  return { cpix, pskc };
}

// Qualified key for a CPIX-namespace element.
function q(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}:${name}`;
}

// Read a child element, requiring it to be in the given namespace prefix.
function child(node: Record<string, unknown>, prefix: string, name: string): unknown {
  return node[q(prefix, name)];
}

// Text value of an element that may be either a bare string (no attributes) or
// an object carrying `#text` next to its attributes (R1: `HLSSignalingDataType`
// and `ContentProtectionDataType` are simple content WITH attributes).
// Returns undefined for an absent or empty element — `<cpix:PSSH/>` is the
// EMPTY PLACEHOLDER the request sent, and a provider that echoes it unfilled
// has supplied nothing.
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (isRecord(value)) {
    const text = value['#text'];
    if (typeof text === 'string' && text.length > 0) return text;
  }
  return undefined;
}

function attrOf(node: Record<string, unknown>, name: string): string | undefined {
  const value = node[`@_${name}`];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// Strict base64 decode. `Buffer.from(s, 'base64')` is famously lenient (it
// skips anything outside the alphabet), so the shape is checked first and the
// round trip is verified: a value that does not re-encode to itself was not
// base64, and a key that is silently truncated by a lenient decoder is worse
// than a rejected response.
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(value: string, detail: string): Buffer {
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) {
    throw invalidResponse(detail);
  }
  const decoded = Buffer.from(compact, 'base64');
  if (decoded.toString('base64') !== compact) throw invalidResponse(detail);
  return decoded;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

// Parse a CPIX key response into the port's return shape (ADR-008 §5.1,
// §6 step 5). EVERY failure — oversized, DTD-bearing, malformed, wrong
// namespace, missing `PlainValue`, unexpected key length — surfaces as
// `KeyProviderError` with `errorCode: 'key_provider_invalid_response'` and a
// message written in this file. The provider's bytes are never echoed.
//
// The returned `keys[].key` is TRANSIENT key material (ADR-008 D4): hand it to
// the packaging job and drop the reference. Never log it, never persist it.
export async function parseCpixResponse(
  body: string,
  expectation: CpixResponseExpectation,
  deps: CpixResponseParseDeps = {}
): Promise<{ keys: ContentKey[]; signalling: DrmSignalling }> {
  // 1. SIZE, first and before anything else touches the body.
  if (isCpixResponseTooLarge(body)) {
    throw invalidResponse('response exceeds the maximum accepted size');
  }
  // 2. No DTD. Also before parsing (R4: a DOCTYPE is scanned even with entity
  //    processing disabled).
  assertNoDoctype(body);

  const parseXml = deps.parseXml ?? (await hardenedParser()).parse;

  let doc: unknown;
  try {
    doc = parseXml(body);
  } catch {
    // The parser's own message quotes the offending document, so it is
    // discarded rather than wrapped (ADR-008 §10).
    throw invalidResponse('response is not well-formed XML');
  }

  const { key: rootKey, node: root } = findRoot(doc);
  const ns = resolvePrefixes(rootKey, root);

  // --- Content keys -------------------------------------------------------
  // kid -> track group comes from the request (see `CpixResponseExpectation`).
  // Compared case-insensitively: `cpix:UUIDType` (R1 cpix.xsd:6-10) admits both
  // cases and a provider is free to echo a kid in either.
  const groupByKid = new Map<string, TrackTypeGroup>();
  for (const { trackGroup, keyId } of expectation.keyIds) {
    groupByKid.set(keyId.toLowerCase(), trackGroup);
  }

  const keyList = child(root, ns.cpix, 'ContentKeyList');
  const contentKeyNodes = isRecord(keyList) ? asArray(child(keyList, ns.cpix, 'ContentKey')) : [];

  const keys: ContentKey[] = [];
  const seenGroups = new Set<TrackTypeGroup>();
  for (const node of contentKeyNodes) {
    if (!isRecord(node)) throw invalidResponse('ContentKey is not an element');
    const kid = attrOf(node, 'kid');
    if (kid === undefined || !DRM_SYSTEM_ID_PATTERN.test(kid)) {
      // `@kid` is REQUIRED and is a `cpix:UUIDType` (R1 cpix.xsd:144).
      throw invalidResponse('ContentKey@kid is missing or not a UUID');
    }
    const trackGroup = groupByKid.get(kid.toLowerCase());
    if (trackGroup === undefined) {
      // A key for a kid we did not ask for. Ignored rather than fatal: a
      // provider may return extra keys (e.g. a key period it manages itself),
      // and the keys the caller needs are checked for completeness below.
      continue;
    }
    if (seenGroups.has(trackGroup)) {
      throw invalidResponse('response carries more than one key for a track group');
    }

    const data = child(node, ns.cpix, 'Data');
    if (!isRecord(data)) throw invalidResponse('ContentKey/Data is missing');
    // `Secret` is in the PSKC namespace (R2). A document that never declared
    // PSKC cannot carry one.
    const secret = ns.pskc === undefined ? undefined : child(data, ns.pskc, 'Secret');
    if (secret === undefined) throw invalidResponse('ContentKey/Data/Secret is missing');
    // An EMPTY `<pskc:Secret/>` parses to a string, not a record — which is
    // the "provider echoed the placeholder back" case, i.e. no PlainValue.
    const plainValue = isRecord(secret)
      ? textOf(child(secret, ns.pskc as string, 'PlainValue'))
      : undefined;
    if (plainValue === undefined) {
      // Either absent, or an `EncryptedValue` instead (R2's choice). Document
      // encryption is explicitly out of scope for v1: ADR-008 §6 "Response
      // shape" — "v1 requires TLS and accepts plain values".
      throw invalidResponse('ContentKey/Data/Secret/PlainValue is missing');
    }
    const keyBytes = decodeBase64(plainValue, 'content key is not base64');
    if (keyBytes.length !== CONTENT_KEY_BYTES) {
      throw invalidResponse('content key is not 16 bytes');
    }

    const contentKey: ContentKey = {
      trackGroup,
      keyId: kid,
      // A copy into a plain `Uint8Array`: a `Buffer` is a view on a pooled
      // allocation, and a pooled view of key material is a view that outlives
      // the use site.
      key: new Uint8Array(keyBytes)
    };
    // `@explicitIV` is `xs:base64Binary` on the wire (R1 cpix.xsd:145, R3
    // key_server_common.py:198) while `ContentKey.iv` is HEX (ADR-008 §5.1),
    // so it is transcoded here rather than passed through in the wrong
    // encoding.
    const explicitIv = attrOf(node, 'explicitIV');
    if (explicitIv !== undefined) {
      contentKey.iv = decodeBase64(explicitIv, 'ContentKey@explicitIV is not base64').toString(
        'hex'
      );
    }
    keys.push(contentKey);
    seenGroups.add(trackGroup);
  }

  for (const { trackGroup } of expectation.keyIds) {
    if (!seenGroups.has(trackGroup)) {
      throw invalidResponse('response is missing a key for a requested track group');
    }
  }

  // --- Signalling ---------------------------------------------------------
  const pssh: Record<DrmSystemId, string> = {};
  const contentProtectionData: Record<DrmSystemId, string> = {};
  const hlsSignallingData: Record<DrmSystemId, string> = {};
  let hlsKeyUri: string | undefined;

  const systemList = child(root, ns.cpix, 'DRMSystemList');
  const systemNodes = isRecord(systemList) ? asArray(child(systemList, ns.cpix, 'DRMSystem')) : [];
  for (const node of systemNodes) {
    if (!isRecord(node)) throw invalidResponse('DRMSystem is not an element');
    const systemId = attrOf(node, 'systemId');
    if (systemId === undefined || !DRM_SYSTEM_ID_PATTERN.test(systemId)) {
      // REQUIRED `cpix:UUIDType` (R1 cpix.xsd:114). Validated before it is used
      // as a record KEY, which is also what keeps an attacker-chosen property
      // name out of these objects.
      throw invalidResponse('DRMSystem@systemId is missing or not a UUID');
    }
    const key = systemId.toLowerCase();

    const psshText = textOf(child(node, ns.cpix, 'PSSH'));
    if (psshText !== undefined) {
      // Passed through as base64 (`DrmSignalling.pssh`: "Base64 PSSH box per
      // system"), but still VALIDATED as base64 so a malformed blob fails here
      // rather than inside a packager.
      decodeBase64(psshText, 'DRMSystem/PSSH is not base64');
      pssh[key] = psshText;
    }
    const cpdText = textOf(child(node, ns.cpix, 'ContentProtectionData'));
    if (cpdText !== undefined) {
      decodeBase64(cpdText, 'DRMSystem/ContentProtectionData is not base64');
      contentProtectionData[key] = cpdText;
    }

    // 0..2 `HLSSignalingData` (R1 cpix.xsd:108), distinguished by `@playlist`.
    // `DrmSignalling.hlsSignallingData` is ONE string per system (ADR-008
    // §5.1), so the MEDIA playlist line is kept: it is the `#EXT-X-KEY` line a
    // media playlist needs, and the multivariant (`master`) line is derivable
    // from it by the packager. Recorded as a known narrowing rather than
    // widening a contract type from this ticket.
    const hlsNodes = asArray(child(node, ns.cpix, 'HLSSignalingData'));
    let media: string | undefined;
    let fallback: string | undefined;
    for (const hlsNode of hlsNodes) {
      const text = textOf(hlsNode);
      if (text === undefined) continue;
      decodeBase64(text, 'DRMSystem/HLSSignalingData is not base64');
      const playlist = isRecord(hlsNode) ? attrOf(hlsNode, 'playlist') : undefined;
      if (playlist === 'media') media = text;
      else if (fallback === undefined) fallback = text;
    }
    const hls = media ?? fallback;
    if (hls !== undefined) hlsSignallingData[key] = hls;

    // `URIExtXKey` — CPIX 2.0/2.1, SPEKE v1 responses only (R3
    // key_server_common.py:89/:97, where its text is base64 of the EXT-X-KEY
    // URI). Decoded to the URI itself, because `DrmSignalling.hlsKeyUri` is a
    // URI ("HLS key URI"), not base64. First one wins: the contract carries a
    // single URI and every system on a v1 response points at the same key
    // endpoint.
    const uriExtXKey = textOf(child(node, ns.cpix, 'URIExtXKey'));
    if (uriExtXKey !== undefined && hlsKeyUri === undefined) {
      hlsKeyUri = decodeBase64(uriExtXKey, 'DRMSystem/URIExtXKey is not base64').toString('utf8');
    }
  }

  const signalling: DrmSignalling = {
    pssh,
    // Licence URLs are CONFIGURATION (ADR-008 §5.2 `licenceUrls`), not a CPIX
    // response element — there is no element for them in the schema (R1). The
    // adapter overlays its configured values; the parser reports what the
    // document actually contained, which is nothing.
    licenceUrls: {}
  };
  if (Object.keys(contentProtectionData).length > 0) {
    signalling.contentProtectionData = contentProtectionData;
  }
  if (Object.keys(hlsSignallingData).length > 0) {
    signalling.hlsSignallingData = hlsSignallingData;
  }
  if (hlsKeyUri !== undefined) signalling.hlsKeyUri = hlsKeyUri;

  return { keys, signalling };
}
