// CPIX response parser — hostile-input and happy-path unit tests
// (ADR-008 §13 "Unit": "CPIX response parser against recorded provider
// responses, including a hostile-input set (entity bomb, oversized document,
// wrong namespace, missing `PlainValue`)"; issue #1261).
//
// The fixtures below are built from the contracts cited in the header of
// src/drm/cpix-response.ts (R1 cpix.xsd, R2 pskc.xsd, R3 the open source SPEKE
// reference key server's response builder), not from memory: element names,
// namespaces, the `ContentKey/Data/pskc:Secret/pskc:PlainValue` key path, the
// base64 `@explicitIV` and the base64 `URIExtXKey` all come from there.
//
// NOTHING HERE TOUCHES A NETWORK OR A CREDENTIAL: the parser is a pure
// function of a string.

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_CPIX_RESPONSE_BYTES,
  NS_CPIX,
  NS_PSKC,
  parseCpixResponse
} from '../src/drm/cpix-response.js';
import { KeyProviderError } from '../src/drm/key-provider-error.js';

// Registered common-encryption system ids (DASH-IF Content Protection
// Identifiers registry). A system is identified by its id, never by a product
// name (CLAUDE.md rule 1, ADR-008 §5.3).
const SYSTEM_ID_A = 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed';
const SYSTEM_ID_B = '9a04f079-9840-4286-ab92-e65be0885f95';

const KID_HD = '8b3f2c9e-8fb0-4a9c-9c5e-3b4d6f708c92';
const KID_AUDIO = '6f1d0a7c-6d9e-4e7a-9a3c-1f2b4d5e6a70';

// 16 bytes — the only key length common encryption uses (ADR-008 §5.1).
const KEY_HD_BASE64 = Buffer.from('0123456789abcdef', 'utf8').toString('base64');
const KEY_AUDIO_BASE64 = Buffer.from('fedcba9876543210', 'utf8').toString('base64');
const IV_BASE64 = Buffer.from('00112233445566778899aabbccddeeff', 'hex').toString('base64');
const PSSH_BASE64 = Buffer.from('pssh-box-bytes-a', 'utf8').toString('base64');
const CPD_BASE64 = Buffer.from('<ContentProtection/>', 'utf8').toString('base64');
const HLS_MEDIA_BASE64 = Buffer.from('#EXT-X-KEY:METHOD=SAMPLE-AES', 'utf8').toString('base64');
const HLS_MASTER_BASE64 = Buffer.from('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES', 'utf8').toString(
  'base64'
);
const EXT_X_KEY_URI = 'skd://testserver/key/1234';
const URI_EXT_X_KEY_BASE64 = Buffer.from(EXT_X_KEY_URI, 'utf8').toString('base64');

const HD_ONLY = { keyIds: [{ trackGroup: 'HD' as const, keyId: KID_HD }] };

// A SPEKE v2 / CPIX 2.3 response for one key and two systems, shaped exactly as
// the reference key server emits one (R3): the request's empty placeholders
// filled in, `Data/Secret/PlainValue` appended to each `ContentKey`.
function validResponse(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<cpix:CPIX contentId="01K9ZP4V7R8HTQ2B6WMNXE3C5D" version="2.3" xmlns:cpix="${NS_CPIX}" xmlns:pskc="${NS_PSKC}">
  <cpix:ContentKeyList>
    <cpix:ContentKey kid="${KID_HD}" commonEncryptionScheme="cbcs" explicitIV="${IV_BASE64}">
      <cpix:Data>
        <pskc:Secret>
          <pskc:PlainValue>${KEY_HD_BASE64}</pskc:PlainValue>
        </pskc:Secret>
      </cpix:Data>
    </cpix:ContentKey>
  </cpix:ContentKeyList>
  <cpix:DRMSystemList>
    <cpix:DRMSystem kid="${KID_HD}" systemId="${SYSTEM_ID_A}">
      <cpix:PSSH>${PSSH_BASE64}</cpix:PSSH>
      <cpix:ContentProtectionData robustness="SW_SECURE_CRYPTO">${CPD_BASE64}</cpix:ContentProtectionData>
      <cpix:HLSSignalingData playlist="master">${HLS_MASTER_BASE64}</cpix:HLSSignalingData>
      <cpix:HLSSignalingData playlist="media">${HLS_MEDIA_BASE64}</cpix:HLSSignalingData>
    </cpix:DRMSystem>
    <cpix:DRMSystem kid="${KID_HD}" systemId="${SYSTEM_ID_B}">
      <cpix:PSSH>${PSSH_BASE64}</cpix:PSSH>
      <cpix:URIExtXKey>${URI_EXT_X_KEY_BASE64}</cpix:URIExtXKey>
    </cpix:DRMSystem>
  </cpix:DRMSystemList>
</cpix:CPIX>
`;
}

async function expectInvalidResponse(promise: Promise<unknown>): Promise<KeyProviderError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(KeyProviderError);
  const keyError = error as KeyProviderError;
  // ADR-008 §8 enum member, mapped for every parse failure (ADR-008 §12).
  expect(keyError.errorCode).toBe('key_provider_invalid_response');
  return keyError;
}

describe('CPIX response parser — valid document', () => {
  it('extracts the content key from ContentKey/Data/pskc:Secret/PlainValue', async () => {
    const { keys } = await parseCpixResponse(validResponse(), HD_ONLY);

    expect(keys).toHaveLength(1);
    expect(keys[0].trackGroup).toBe('HD');
    expect(keys[0].keyId).toBe(KID_HD);
    // base64 -> Uint8Array (issue #1261), 16 bytes.
    expect(keys[0].key).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(keys[0].key).toString('base64')).toBe(KEY_HD_BASE64);
    expect(keys[0].key).toHaveLength(16);
    // `@explicitIV` is base64 on the wire (cpix.xsd:145) and hex on
    // `ContentKey.iv` (ADR-008 §5.1).
    expect(keys[0].iv).toBe('00112233445566778899aabbccddeeff');
  });

  it('extracts per-system PSSH, ContentProtectionData, HLSSignallingData and URIExtXKey', async () => {
    const { signalling } = await parseCpixResponse(validResponse(), HD_ONLY);

    expect(signalling.pssh).toEqual({
      [SYSTEM_ID_A]: PSSH_BASE64,
      [SYSTEM_ID_B]: PSSH_BASE64
    });
    // Simple content with an attribute (cpix.xsd:97-103) still yields its text.
    expect(signalling.contentProtectionData).toEqual({ [SYSTEM_ID_A]: CPD_BASE64 });
    // The `media` playlist line is the one kept (see the narrowing note in
    // src/drm/cpix-response.ts), even though `master` came first in document
    // order.
    expect(signalling.hlsSignallingData).toEqual({ [SYSTEM_ID_A]: HLS_MEDIA_BASE64 });
    // `URIExtXKey` is base64 of the URI (R3), so the parser returns the URI.
    expect(signalling.hlsKeyUri).toBe(EXT_X_KEY_URI);
    // Licence URLs are configuration, not response data (ADR-008 §5.2).
    expect(signalling.licenceUrls).toEqual({});
    // No development marker: that is the clear-key adapter's alone.
    expect(signalling.dev).toBeUndefined();
  });

  it('ignores a key for a kid that was not requested', async () => {
    const withExtraKey = validResponse().replace(
      '  </cpix:ContentKeyList>',
      `    <cpix:ContentKey kid="${KID_AUDIO}">
      <cpix:Data>
        <pskc:Secret>
          <pskc:PlainValue>${KEY_AUDIO_BASE64}</pskc:PlainValue>
        </pskc:Secret>
      </cpix:Data>
    </cpix:ContentKey>
  </cpix:ContentKeyList>`
    );

    const { keys } = await parseCpixResponse(withExtraKey, HD_ONLY);

    expect(keys).toHaveLength(1);
    expect(keys[0].keyId).toBe(KID_HD);
  });

  it('rejects a response that omits a key for a requested track group', async () => {
    await expectInvalidResponse(
      parseCpixResponse(validResponse(), {
        keyIds: [
          { trackGroup: 'HD', keyId: KID_HD },
          { trackGroup: 'AUDIO', keyId: KID_AUDIO }
        ]
      })
    );
  });
});

describe('CPIX response parser — hostile input (ADR-008 §13)', () => {
  it('rejects an entity bomb BEFORE the XML parser is called', async () => {
    // The classic quadratic entity expansion. Entity expansion is already
    // disabled (`processEntities: false`), and on top of that a document type
    // declaration is refused outright — which is what makes this rejection
    // happen before a single byte reaches the parser.
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE CPIX [
  <!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
  <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
]>
<cpix:CPIX xmlns:cpix="${NS_CPIX}" xmlns:pskc="${NS_PSKC}">
  <cpix:ContentKeyList>
    <cpix:ContentKey kid="${KID_HD}">
      <cpix:Data><pskc:Secret><pskc:PlainValue>&d;</pskc:PlainValue></pskc:Secret></cpix:Data>
    </cpix:ContentKey>
  </cpix:ContentKeyList>
</cpix:CPIX>`;
    const parseXml = vi.fn(() => {
      throw new Error('the parser must not be reached');
    });

    await expectInvalidResponse(parseCpixResponse(bomb, HD_ONLY, { parseXml }));

    expect(parseXml).not.toHaveBeenCalled();
  });

  it('rejects an oversized document at the size check, without parsing', async () => {
    // 256 KiB + 1 byte of otherwise well-formed padding (ADR-008 §10/§11
    // item 4; issue #1261 "Cap input at 256 KiB before parsing — reject larger
    // bodies without parsing").
    const padding = 'A'.repeat(MAX_CPIX_RESPONSE_BYTES + 1);
    const oversized = validResponse().replace(KEY_HD_BASE64, padding);
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(MAX_CPIX_RESPONSE_BYTES);
    const parseXml = vi.fn(() => {
      throw new Error('the parser must not be reached');
    });

    const error = await expectInvalidResponse(
      parseCpixResponse(oversized, HD_ONLY, { parseXml })
    );

    expect(parseXml).not.toHaveBeenCalled();
    expect(error.message).toContain('maximum accepted size');
  });

  it('rejects a document in the wrong CPIX namespace', async () => {
    const wrongNamespace = validResponse().replace(NS_CPIX, 'urn:example:not-cpix');

    await expectInvalidResponse(parseCpixResponse(wrongNamespace, HD_ONLY));
  });

  it('rejects a document whose root is not CPIX at all', async () => {
    await expectInvalidResponse(
      parseCpixResponse('<html><body>provider error page</body></html>', HD_ONLY)
    );
  });

  it('rejects a ContentKey with no PlainValue', async () => {
    const noPlainValue = validResponse().replace(
      `<pskc:PlainValue>${KEY_HD_BASE64}</pskc:PlainValue>`,
      ''
    );

    const error = await expectInvalidResponse(parseCpixResponse(noPlainValue, HD_ONLY));

    expect(error.message).toContain('PlainValue');
  });

  it('rejects a Secret that carries an EncryptedValue instead of a PlainValue', async () => {
    // Document encryption is out of scope for v1 (ADR-008 §6 "Response
    // shape": "v1 requires TLS and accepts plain values").
    const encrypted = validResponse().replace(
      `<pskc:PlainValue>${KEY_HD_BASE64}</pskc:PlainValue>`,
      '<pskc:EncryptedValue><enc:CipherData/></pskc:EncryptedValue>'
    );

    await expectInvalidResponse(parseCpixResponse(encrypted, HD_ONLY));
  });

  it('rejects malformed XML', async () => {
    await expectInvalidResponse(
      parseCpixResponse(validResponse().replace('</cpix:CPIX>', ''), HD_ONLY)
    );
  });

  it('rejects a key that is not 16 bytes', async () => {
    const shortKey = validResponse().replace(
      KEY_HD_BASE64,
      Buffer.from('too short', 'utf8').toString('base64')
    );

    await expectInvalidResponse(parseCpixResponse(shortKey, HD_ONLY));
  });

  it('rejects a PlainValue that is not base64', async () => {
    const notBase64 = validResponse().replace(KEY_HD_BASE64, 'not base64 at all!!');

    await expectInvalidResponse(parseCpixResponse(notBase64, HD_ONLY));
  });

  it('rejects a ContentKey whose kid is not a UUID', async () => {
    const badKid = validResponse().replace(`kid="${KID_HD}"`, 'kid="not-a-uuid"');

    await expectInvalidResponse(parseCpixResponse(badKid, HD_ONLY));
  });

  it('rejects a DRMSystem whose systemId is not a UUID (no attacker-chosen record key)', async () => {
    const badSystemId = validResponse().replace(
      `systemId="${SYSTEM_ID_A}"`,
      'systemId="__proto__"'
    );

    await expectInvalidResponse(parseCpixResponse(badSystemId, HD_ONLY));
  });

  it('never surfaces the provider document in the error message', async () => {
    const secretish = 'PROVIDER-ERROR-BODY-DO-NOT-ECHO';
    const error = await expectInvalidResponse(
      parseCpixResponse(`<error>${secretish}</error>`, HD_ONLY)
    );

    expect(error.message).not.toContain(secretish);
  });
});
