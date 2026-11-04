// CPIX 2.3 / SPEKE key-request document builder — golden-file tests
// (ADR-008 §6, §13 "Unit"; issue #1260).
//
// The golden files in test/golden/ are the contract this builder is held to:
// any change to an element name, attribute name, attribute value, child order
// or indentation fails these tests, which is exactly the acceptance criterion
// ("changing any field in the builder causes the tests to fail"). Three files,
// so the diff between them IS the documented difference:
//   - cpix-request-speke-v1.xml            — SPEKE v1, three track groups, two systems
//   - cpix-request-speke-v2.xml            — the SAME request, SPEKE v2 (CPIX 2.3)
//   - cpix-request-speke-v2-single-key.xml — SPEKE v2, single-key profile (the D3 default)
//
// Contract sources for the expected documents are cited in the header of
// src/drm/cpix-request.ts (X1 the CPIX 2.3 XSD, X2 the SPEKE v2 reference
// request documents, X3 the SPEKE v1 reference request document). The goldens
// were checked element-by-element against X2/X3.
//
// ONE KNOWN DEVIATION IS BAKED INTO cpix-request-speke-v1.xml: its root
// `id="01K9ZP4V7R8HTQ2B6WMNXE3C5D"` is not a valid `xs:ID` (cpix.xsd:194),
// because an `xs:ID` is an NCName and a ULID starts with a digit. That is the
// v1 wire format, not a mistake — the reasoning, the contracts and the
// alternative are written out at the root-element comment in
// src/drm/cpix-request.ts and pinned by the last describe block in this file.
// A comment cannot live inside the golden itself: it is compared byte-for-byte,
// so anything in the file is also on the wire.
//
// NOTHING HERE TOUCHES A NETWORK OR A CREDENTIAL: the builder is pure string
// construction, and no test in this file constructs a URL, a provider
// coordinate or an environment credential.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VIDEO_PIXEL_BOUNDS,
  buildCpixRequest,
  type CpixRequestOptions
} from '../src/drm/cpix-request.js';
import { DEFAULT_DRM_SYSTEM_IDS, resolveDrmSystemIds } from '../src/drm/key-provider.js';
import type { KeyRequest } from '../src/drm/key-provider.js';

const golden = (name: string): string =>
  readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8');

// Registered common-encryption system ids (DASH-IF Content Protection
// Identifiers registry). A DRM system is identified by this UUID and never by a
// product name (CLAUDE.md rule 1, ADR-008 §5.3) — the same two ids the #1259
// document round-trip test uses.
const SYSTEM_ID_A = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const SYSTEM_ID_B = '9a04f079-9840-4286-ab92-e65be0885f95';

// Key ids are PINNED in these fixtures so the documents are byte-deterministic
// (the re-package path pins them for real, ADR-008 §6 "Idempotency").
const KID_AUDIO = '6f1d0a7c-6d9e-4e7a-9a3c-1f2b4d5e6a70';
const KID_SD = '7a2e1b8d-7eaf-4f8b-8b4d-2a3c5e6f7b81';
const KID_HD = '8b3f2c9e-8fb0-4a9c-9c5e-3b4d6f708c92';

const MULTI_GROUP_REQUEST: KeyRequest = {
  contentId: '01K9ZP4V7R8HTQ2B6WMNXE3C5D',
  systems: [SYSTEM_ID_A, SYSTEM_ID_B],
  scheme: 'cbcs',
  trackGroups: ['AUDIO', 'SD', 'HD'],
  keyIds: { AUDIO: KID_AUDIO, SD: KID_SD, HD: KID_HD }
};

const SINGLE_KEY_REQUEST: KeyRequest = {
  contentId: '01K9ZP4V7R8HTQ2B6WMNXE3C5D',
  systems: [SYSTEM_ID_A, SYSTEM_ID_B],
  scheme: 'cbcs',
  trackGroups: ['HD'],
  keyIds: { HD: KID_HD }
};

// A minted key id would make the output non-deterministic, so every golden
// pins its kids; this stub exists only to prove the builder never falls back to
// minting when all kids are pinned.
const explodingMint: CpixRequestOptions['newKeyId'] = () => {
  throw new Error('newKeyId must not be called when every track group is pinned');
};

describe('CPIX/SPEKE request builder — golden documents', () => {
  it('emits the SPEKE v1 document byte-for-byte', () => {
    const { document } = buildCpixRequest(MULTI_GROUP_REQUEST, {
      spekeVersion: '1.0',
      newKeyId: explodingMint
    });
    expect(document).toBe(golden('cpix-request-speke-v1.xml'));
  });

  it('emits the SPEKE v2 (CPIX 2.3) document byte-for-byte', () => {
    const { document } = buildCpixRequest(MULTI_GROUP_REQUEST, {
      spekeVersion: '2.0',
      newKeyId: explodingMint
    });
    expect(document).toBe(golden('cpix-request-speke-v2.xml'));
  });

  it('emits the single-key profile document byte-for-byte', () => {
    const { document } = buildCpixRequest(SINGLE_KEY_REQUEST, {
      spekeVersion: '2.0',
      newKeyId: explodingMint
    });
    expect(document).toBe(golden('cpix-request-speke-v2-single-key.xml'));
  });
});

// The dialect differences the two same-request goldens encode (ADR-008 §6
// "SPEKE v1 fallback"). Asserted explicitly as well as by the goldens, so a
// regression says WHICH rule broke rather than only "the bytes changed".
describe('CPIX/SPEKE request builder — dialect differences', () => {
  const v1 = buildCpixRequest(MULTI_GROUP_REQUEST, {
    spekeVersion: '1.0',
    newKeyId: explodingMint
  }).document;
  const v2 = buildCpixRequest(MULTI_GROUP_REQUEST, {
    spekeVersion: '2.0',
    newKeyId: explodingMint
  }).document;

  it('carries the content id in @id on v1 and @contentId + @version on v2', () => {
    expect(v1).toContain(`<cpix:CPIX id="${MULTI_GROUP_REQUEST.contentId}"`);
    expect(v1).not.toContain('contentId=');
    expect(v1).not.toContain('version="2.3"');
    expect(v2).toContain(`<cpix:CPIX contentId="${MULTI_GROUP_REQUEST.contentId}" version="2.3"`);
    expect(v2).not.toContain('<cpix:CPIX id=');
  });

  it('binds only the namespaces each dialect declares', () => {
    expect(v1).toContain('xmlns:cpix="urn:dashif:org:cpix"');
    expect(v1).toContain('xmlns:pskc="urn:ietf:params:xml:ns:keyprov:pskc"');
    expect(v1).not.toContain('xmlns:ds=');
    expect(v1).not.toContain('xmlns:enc=');
    expect(v2).toContain('xmlns:ds="http://www.w3.org/2000/09/xmldsig#"');
    expect(v2).toContain('xmlns:enc="http://www.w3.org/2001/04/xmlenc#"');
  });

  it('puts @commonEncryptionScheme and @intendedTrackType on the v2 path only', () => {
    expect(v2).toContain(`<cpix:ContentKey kid="${KID_HD}" commonEncryptionScheme="cbcs"/>`);
    expect(v1).toContain(`<cpix:ContentKey kid="${KID_HD}"/>`);
    expect(v2).toContain('intendedTrackType="VIDEO"');
    expect(v2).toContain('intendedTrackType="AUDIO"');
    expect(v1).not.toContain('intendedTrackType');
  });

  it('uses HLSSignalingData placeholders on v2 and URIExtXKey on v1', () => {
    expect(v2).toContain('<cpix:HLSSignalingData playlist="media"/>');
    expect(v2).toContain('<cpix:HLSSignalingData playlist="master"/>');
    expect(v2).not.toContain('URIExtXKey');
    expect(v1).toContain('<cpix:URIExtXKey/>');
    expect(v1).not.toContain('HLSSignalingData');
  });
});

describe('CPIX/SPEKE request builder — document structure', () => {
  it('emits one DRMSystem per (kid, systemId) pair', () => {
    const { document } = buildCpixRequest(MULTI_GROUP_REQUEST, {
      spekeVersion: '2.0',
      newKeyId: explodingMint
    });
    const systems = document.match(/<cpix:DRMSystem /g) ?? [];
    expect(systems).toHaveLength(3 * 2);
    for (const kid of [KID_AUDIO, KID_SD, KID_HD]) {
      expect(document).toContain(`<cpix:DRMSystem kid="${kid}" systemId="${SYSTEM_ID_A}">`);
      expect(document).toContain(`<cpix:DRMSystem kid="${kid}" systemId="${SYSTEM_ID_B}">`);
    }
  });

  it('keeps the CpixType child sequence: keys, systems, usage rules', () => {
    const { document } = buildCpixRequest(MULTI_GROUP_REQUEST, {
      spekeVersion: '2.0',
      newKeyId: explodingMint
    });
    // cpix.xsd:185-193 fixes this order; an out-of-order document is invalid.
    expect(document.indexOf('<cpix:ContentKeyList>')).toBeLessThan(
      document.indexOf('<cpix:DRMSystemList>')
    );
    expect(document.indexOf('<cpix:DRMSystemList>')).toBeLessThan(
      document.indexOf('<cpix:ContentKeyUsageRuleList>')
    );
  });

  it('bounds each video track group by pixel count when several groups are requested', () => {
    const { document } = buildCpixRequest(MULTI_GROUP_REQUEST, {
      spekeVersion: '2.0',
      newKeyId: explodingMint
    });
    expect(document).toContain(
      `<cpix:VideoFilter maxPixels="${DEFAULT_VIDEO_PIXEL_BOUNDS.SD!.maxPixels}"/>`
    );
    expect(document).toContain(
      `<cpix:VideoFilter minPixels="${DEFAULT_VIDEO_PIXEL_BOUNDS.HD!.minPixels}" maxPixels="${DEFAULT_VIDEO_PIXEL_BOUNDS.HD!.maxPixels}"/>`
    );
    // AUDIO is bounded by media type, not by pixels.
    expect(document).toContain('<cpix:AudioFilter/>');
  });

  it('honours configured pixel bounds over the defaults', () => {
    const { document } = buildCpixRequest(MULTI_GROUP_REQUEST, {
      spekeVersion: '2.0',
      newKeyId: explodingMint,
      videoPixelBounds: { SD: { maxPixels: 230400 }, HD: { minPixels: 230401 } }
    });
    expect(document).toContain('<cpix:VideoFilter maxPixels="230400"/>');
    expect(document).toContain('<cpix:VideoFilter minPixels="230401"/>');
    expect(document).not.toContain('maxPixels="414720"');
  });

  it('covers both media types with one rule in the single-key profile', () => {
    const { document } = buildCpixRequest(SINGLE_KEY_REQUEST, {
      spekeVersion: '2.0',
      newKeyId: explodingMint
    });
    expect(document).toContain(
      `<cpix:ContentKeyUsageRule kid="${KID_HD}" intendedTrackType="ALL">`
    );
    expect(document).toContain('<cpix:VideoFilter/>');
    expect(document).toContain('<cpix:AudioFilter/>');
    expect(document.match(/<cpix:ContentKeyUsageRule /g) ?? []).toHaveLength(1);
  });

  it('adds operator-configured extension placeholders on the v1 path only', () => {
    // The extension namespace is configuration, never a constant in this repo
    // (see the naming note in src/drm/cpix-request.ts) — so this test supplies
    // its own neutral example namespace.
    const extensionNamespace = {
      prefix: 'ext',
      uri: 'urn:example:cpix-extension',
      placeholderElements: ['KeyFormat', 'KeyFormatVersions']
    };
    const { document } = buildCpixRequest(MULTI_GROUP_REQUEST, {
      spekeVersion: '1.0',
      newKeyId: explodingMint,
      extensionNamespace
    });
    expect(document).toContain('xmlns:ext="urn:example:cpix-extension"');
    expect(document).toContain('<ext:KeyFormat/>');
    expect(document).toContain('<ext:KeyFormatVersions/>');
    // v2's namespace set is fixed by the spec, so the hook is ignored there.
    const v2Document = buildCpixRequest(MULTI_GROUP_REQUEST, {
      spekeVersion: '2.0',
      newKeyId: explodingMint,
      extensionNamespace
    }).document;
    expect(v2Document).not.toContain('urn:example:cpix-extension');
    expect(v2Document).not.toContain('<ext:');
  });
});

describe('CPIX/SPEKE request builder — key ids', () => {
  it('returns the key id used for every requested track group', () => {
    const { keyIds } = buildCpixRequest(MULTI_GROUP_REQUEST, {
      spekeVersion: '2.0',
      newKeyId: explodingMint
    });
    expect(keyIds).toEqual([
      { trackGroup: 'AUDIO', keyId: KID_AUDIO },
      { trackGroup: 'SD', keyId: KID_SD },
      { trackGroup: 'HD', keyId: KID_HD }
    ]);
  });

  it('mints a UUID kid for an unpinned track group and reports it back', () => {
    const minted = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const { document, keyIds } = buildCpixRequest(
      { ...MULTI_GROUP_REQUEST, keyIds: { AUDIO: KID_AUDIO } },
      { spekeVersion: '2.0', newKeyId: () => minted }
    );
    expect(keyIds.map((k) => k.keyId)).toEqual([KID_AUDIO, minted, minted]);
    expect(document).toContain(`<cpix:ContentKey kid="${minted}"`);
  });

  it('mints real UUIDs when no generator is injected', () => {
    const { keyIds } = buildCpixRequest(
      { ...MULTI_GROUP_REQUEST, keyIds: undefined },
      { spekeVersion: '2.0' }
    );
    for (const { keyId } of keyIds) {
      expect(keyId).toMatch(
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
      );
    }
    expect(new Set(keyIds.map((k) => k.keyId)).size).toBe(keyIds.length);
  });

  it('carries no key material of any kind', () => {
    // ADR-008 D4: a request document asks the provider to MINT keys; it never
    // contains one. `pskc:Secret`/`PlainValue` is a RESPONSE-only element.
    const { document } = buildCpixRequest(MULTI_GROUP_REQUEST, {
      spekeVersion: '2.0',
      newKeyId: explodingMint
    });
    expect(document).not.toContain('Secret');
    expect(document).not.toContain('PlainValue');
    expect(document).not.toContain('<cpix:Data');
  });
});

describe('CPIX/SPEKE request builder — escaping and validation', () => {
  it('escapes every XML-significant character in an attribute value', () => {
    const { document } = buildCpixRequest(
      { ...SINGLE_KEY_REQUEST, contentId: `a&b<c>d"e'f` },
      { spekeVersion: '1.0', newKeyId: explodingMint }
    );
    expect(document).toContain(`id="a&amp;b&lt;c&gt;d&quot;e&apos;f"`);
    // No raw delimiter survived, i.e. the document cannot be broken out of.
    const root = document.split('\n')[1]!;
    expect(root).not.toContain('"e');
    expect(root).not.toContain('b<c');
  });

  it('does not double-escape an already-escaped-looking value', () => {
    const { document } = buildCpixRequest(
      { ...SINGLE_KEY_REQUEST, contentId: '&amp;' },
      { spekeVersion: '2.0', newKeyId: explodingMint }
    );
    expect(document).toContain('contentId="&amp;amp;"');
  });

  it('rejects a request it cannot build a valid document from', () => {
    const cases: [string, KeyRequest][] = [
      ['contentId is required', { ...SINGLE_KEY_REQUEST, contentId: '' }],
      ['at least one DRM system id', { ...SINGLE_KEY_REQUEST, systems: [] }],
      ['system id is not a UUID', { ...SINGLE_KEY_REQUEST, systems: ['not-a-uuid'] }],
      ['at least one track group', { ...SINGLE_KEY_REQUEST, trackGroups: [] }],
      [
        'track groups must be unique',
        { ...SINGLE_KEY_REQUEST, trackGroups: ['HD', 'HD'], keyIds: { HD: KID_HD } }
      ]
    ];
    for (const [message, req] of cases) {
      expect(() => buildCpixRequest(req, { spekeVersion: '2.0' })).toThrow(message);
    }
  });

  it('rejects a pinned key id that is not a UUID', () => {
    expect(() =>
      buildCpixRequest(
        { ...SINGLE_KEY_REQUEST, keyIds: { HD: 'key-1' } },
        { spekeVersion: '2.0' }
      )
    ).toThrow('not a UUID');
  });
});

describe('system id configuration', () => {
  it('falls back to the well-known defaults when none are configured', () => {
    expect(resolveDrmSystemIds()).toEqual([...DEFAULT_DRM_SYSTEM_IDS]);
    expect(resolveDrmSystemIds([])).toEqual([...DEFAULT_DRM_SYSTEM_IDS]);
  });

  it('prefers configured ids, so a non-default id needs no code change', () => {
    const configured = ['11111111-2222-3333-4444-555555555555'];
    expect(resolveDrmSystemIds(configured)).toEqual(configured);
  });

  it('returns a copy, so the defaults cannot be mutated through it', () => {
    const resolved = resolveDrmSystemIds();
    resolved.push('11111111-2222-3333-4444-555555555555');
    expect(resolveDrmSystemIds()).toEqual([...DEFAULT_DRM_SYSTEM_IDS]);
    expect(DEFAULT_DRM_SYSTEM_IDS).toHaveLength(3);
  });

  it('ships only registry-shaped default ids', () => {
    for (const id of DEFAULT_DRM_SYSTEM_IDS) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    }
  });
});

// A namespace prefix and a placeholder local name are NAMES, not text: they are
// interpolated into `xmlns:<prefix>` and `<prefix:Name/>`, outside any quotes,
// where attribute escaping is no remedy (escaping `<` inside a tag name only
// produces a document no parser accepts). The builder therefore REJECTS a name
// that is not an XML NCName — `Namespaces in XML 1.1` production [4]
// (https://www.w3.org/TR/xml-names11/) — rather than escaping it. These cases
// are the injection attempts that reach a tag name.
describe('CPIX/SPEKE request builder — extension namespace identifiers', () => {
  const validExtension = {
    prefix: 'ext',
    uri: 'urn:example:cpix-extension',
    placeholderElements: ['KeyFormat']
  };

  const build = (extensionNamespace: {
    prefix: string;
    uri: string;
    placeholderElements: readonly string[];
  }): string =>
    buildCpixRequest(SINGLE_KEY_REQUEST, {
      spekeVersion: '1.0',
      newKeyId: explodingMint,
      extensionNamespace
    }).document;

  it('rejects a prefix that is not an NCName', () => {
    for (const prefix of [
      'ext"',
      'ext<x',
      'ext/x',
      'ext>x',
      'e x',
      'ext:more',
      '1ext',
      '-ext',
      '',
      'ext=" onx',
      'ext&x'
    ]) {
      expect(() => build({ ...validExtension, prefix })).toThrow(
        'cpix request: extension namespace prefix is not an XML NCName'
      );
    }
  });

  it('rejects a placeholder element name that is not an NCName', () => {
    for (const name of [
      'Key"Format',
      'Key<Format',
      'KeyFormat/><cpix:Secret',
      'Key>Format',
      'Key Format',
      'Key:Format',
      '1KeyFormat',
      '',
      'KeyFormat xmlns:evil="urn:x"'
    ]) {
      expect(() => build({ ...validExtension, placeholderElements: [name] })).toThrow(
        'cpix request: extension placeholder element name is not an XML NCName'
      );
    }
  });

  it('rejects a prefix that would rebind a namespace the dialect binds itself', () => {
    for (const prefix of ['cpix', 'pskc', 'ds', 'enc', 'xml', 'xmlns']) {
      expect(() => build({ ...validExtension, prefix })).toThrow('is reserved');
    }
  });

  it('rejects an empty extension namespace uri', () => {
    expect(() => build({ ...validExtension, uri: '' })).toThrow(
      'cpix request: extension namespace uri is required'
    );
  });

  it('rejects a bad extension namespace on the v2 path too, not just where it is emitted', () => {
    // v2 ignores the extension when building, so an invalid prefix would
    // otherwise only surface the day a stack is switched to v1.
    expect(() =>
      buildCpixRequest(SINGLE_KEY_REQUEST, {
        spekeVersion: '2.0',
        newKeyId: explodingMint,
        extensionNamespace: { ...validExtension, prefix: 'ext"' }
      })
    ).toThrow('is not an XML NCName');
  });

  it('still accepts a well-formed extension and emits no raw delimiter', () => {
    const document = build({
      ...validExtension,
      placeholderElements: ['KeyFormat', 'KeyFormatVersions', 'ProtectionHeader']
    });
    expect(document).toContain('<ext:KeyFormat/>');
    expect(document).toContain('<ext:KeyFormatVersions/>');
    expect(document).toContain('<ext:ProtectionHeader/>');
    // Every `<` in the document opens a real element or closes one: no tag name
    // carries a quote, an equals sign or a second `<`.
    for (const tag of document.match(/<[^<>]*>/g) ?? []) {
      // Only a tag's NAME is checked for XML-significant characters: an
      // attribute VALUE legitimately carries quotes (`id="..."`, and the XML
      // declaration itself), and values are escaped rather than rejected.
      const name = tag.replace(/^<[?/]?/, '').split(/[\s/>?]/)[0] ?? '';
      expect(name).toMatch(
        /^(?:xml|(?:[A-Za-z_][A-Za-z0-9_.\-]*:)?[A-Za-z_][A-Za-z0-9_.\-]*)$/
      );
      // An extension placeholder is an empty element, so its whole tag is just
      // the name — nothing from configuration can have escaped into it.
      if (!name.startsWith('ext:')) continue;
      expect(tag).not.toContain('"');
    }
  });
});

// `@minPixels`/`@maxPixels` are `xs:integer` (cpix.xsd:36-43). `String(value)`
// of a fractional, huge or non-finite number is not an `xs:integer` lexical
// form, so the builder refuses the bounds instead of emitting a document the
// provider rejects.
describe('CPIX/SPEKE request builder — video pixel bounds validation', () => {
  const build = (bounds: Record<string, { minPixels?: number; maxPixels?: number }>): string =>
    buildCpixRequest(MULTI_GROUP_REQUEST, {
      spekeVersion: '2.0',
      newKeyId: explodingMint,
      videoPixelBounds: bounds
    }).document;

  it('rejects bounds that are not non-negative safe integers', () => {
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
      expect(() => build({ SD: { maxPixels: bad } })).toThrow(
        'maxPixels for track group SD must be a non-negative integer'
      );
      expect(() => build({ HD: { minPixels: bad } })).toThrow(
        'minPixels for track group HD must be a non-negative integer'
      );
    }
  });

  it('rejects an inverted band, which would bind a key to nothing', () => {
    expect(() => build({ HD: { minPixels: 2073600, maxPixels: 414720 } })).toThrow(
      'minPixels for track group HD exceeds maxPixels'
    );
  });

  it('accepts zero and the largest safe integer', () => {
    const document = build({ SD: { minPixels: 0, maxPixels: Number.MAX_SAFE_INTEGER } });
    expect(document).toContain(
      `<cpix:VideoFilter minPixels="0" maxPixels="${Number.MAX_SAFE_INTEGER}"/>`
    );
  });
});

// The v1 root `@id` is a DELIBERATE, documented schema deviation, not an
// oversight: `CpixType/@id` is `xs:ID` (cpix.xsd:194) and an `xs:ID` is an
// NCName (XML Schema Part 2 §3.3.8), which cannot start with a digit, while the
// v1 wire format — the ticket's "Output shape" and the verified v1 reference
// request document, whose own `@id` is a bare digit-leading identifier — puts
// the bare content id there. Same resolution as `playlist="master"`: the wire
// format wins and the deviation is written down. This test pins the deviation
// so it cannot be changed silently; moving v1 to a synthetic NCName `@id` plus
// `@contentId` is a wire-format decision for ADR-008 §6.
describe('CPIX/SPEKE request builder — v1 @id is a recorded xs:ID deviation', () => {
  it('emits the bare content id on v1 and the schema-safe @contentId on v2', () => {
    const ulidContentId = '01K9ZP4V7R8HTQ2B6WMNXE3C5D';
    const v1 = buildCpixRequest(
      { ...SINGLE_KEY_REQUEST, contentId: ulidContentId },
      { spekeVersion: '1.0', newKeyId: explodingMint }
    ).document;
    const v2 = buildCpixRequest(
      { ...SINGLE_KEY_REQUEST, contentId: ulidContentId },
      { spekeVersion: '2.0', newKeyId: explodingMint }
    ).document;
    expect(v1).toContain(`<cpix:CPIX id="${ulidContentId}"`);
    // Leading digit: the value is NOT an NCName, i.e. not a valid xs:ID.
    expect(/^[A-Za-z_]/.test(ulidContentId)).toBe(false);
    // v2 has no such problem — @contentId is xs:string (cpix.xsd:195).
    expect(v2).toContain(`<cpix:CPIX contentId="${ulidContentId}"`);
    expect(v2).not.toContain('<cpix:CPIX id=');
  });
});
