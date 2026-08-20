// Profiles-URL / public-base-URL override precedence tests (issue #285).
//
// #283 confirmed OSC exposes no runtime self-URL, so the ONLY way to point each
// scaler-spawned Encore instance at this deployment's local profile index is an
// explicit operator-set env var. These tests pin the precedence encoded in
// resolveEncoreProfilesUrl(): direct override → derived local index → remote
// default. resolvePublicBaseUrl() is exercised alongside as the base-URL seam.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolvePublicBaseUrl,
  resolveEncoreProfilesUrl,
  LOCAL_PROFILES_INDEX_PATH
} from '../src/services/public-base-url.js';

const DEFAULT_INDEX = 'https://remote.example.test/default-profiles.yml';

describe('resolvePublicBaseUrl (issue #219)', () => {
  const saved = {
    PUBLIC_BASE_URL: process.env['PUBLIC_BASE_URL']
  };

  beforeEach(() => {
    delete process.env['PUBLIC_BASE_URL'];
  });

  afterEach(() => {
    if (saved.PUBLIC_BASE_URL === undefined) delete process.env['PUBLIC_BASE_URL'];
    else process.env['PUBLIC_BASE_URL'] = saved.PUBLIC_BASE_URL;
  });

  it('returns undefined when PUBLIC_BASE_URL is unset', () => {
    expect(resolvePublicBaseUrl()).toBeUndefined();
  });

  it('returns the override, stripped of trailing slashes', () => {
    process.env['PUBLIC_BASE_URL'] = 'https://app.example.test///';
    expect(resolvePublicBaseUrl()).toBe('https://app.example.test');
  });
});

describe('resolveEncoreProfilesUrl override precedence (issue #285)', () => {
  const saved = {
    PUBLIC_BASE_URL: process.env['PUBLIC_BASE_URL'],
    ENCORE_PROFILES_URL_OVERRIDE: process.env['ENCORE_PROFILES_URL_OVERRIDE']
  };

  beforeEach(() => {
    delete process.env['PUBLIC_BASE_URL'];
    delete process.env['ENCORE_PROFILES_URL_OVERRIDE'];
  });

  afterEach(() => {
    for (const key of ['PUBLIC_BASE_URL', 'ENCORE_PROFILES_URL_OVERRIDE'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  });

  it('falls back to the remote default when no operator override is set', () => {
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX)).toBe(DEFAULT_INDEX);
  });

  it('derives the local profile index from PUBLIC_BASE_URL', () => {
    process.env['PUBLIC_BASE_URL'] = 'https://app.example.test';
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX)).toBe(
      `https://app.example.test${LOCAL_PROFILES_INDEX_PATH}`
    );
  });

  it('derives the local index even with a trailing slash on PUBLIC_BASE_URL', () => {
    process.env['PUBLIC_BASE_URL'] = 'https://app.example.test/';
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX)).toBe(
      `https://app.example.test${LOCAL_PROFILES_INDEX_PATH}`
    );
  });

  it('lets ENCORE_PROFILES_URL_OVERRIDE win over the remote default', () => {
    process.env['ENCORE_PROFILES_URL_OVERRIDE'] = 'https://custom.example.test/index.yml';
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX)).toBe('https://custom.example.test/index.yml');
  });

  it('lets ENCORE_PROFILES_URL_OVERRIDE win over the PUBLIC_BASE_URL derivation', () => {
    process.env['PUBLIC_BASE_URL'] = 'https://app.example.test';
    process.env['ENCORE_PROFILES_URL_OVERRIDE'] = 'https://custom.example.test/index.yml';
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX)).toBe('https://custom.example.test/index.yml');
  });

  it('normalises trailing slashes on the direct override', () => {
    process.env['ENCORE_PROFILES_URL_OVERRIDE'] = 'https://custom.example.test/index.yml//';
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX)).toBe('https://custom.example.test/index.yml');
  });

  it('ignores an empty-string override and falls through', () => {
    process.env['ENCORE_PROFILES_URL_OVERRIDE'] = '';
    process.env['PUBLIC_BASE_URL'] = 'https://app.example.test';
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX)).toBe(
      `https://app.example.test${LOCAL_PROFILES_INDEX_PATH}`
    );
  });
});
