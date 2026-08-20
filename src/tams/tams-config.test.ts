import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  TAMS_STORE_URL_ENV,
  readTamsConfig,
  gateTamsIndexing,
  resolveTamsGate
} from './tams-config.js';

// Capture and restore the real env var around every test so manipulating
// process.env.TAMS_STORE_URL never leaks across cases (or to other suites).
const ORIGINAL = process.env[TAMS_STORE_URL_ENV];
afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env[TAMS_STORE_URL_ENV];
  } else {
    process.env[TAMS_STORE_URL_ENV] = ORIGINAL;
  }
  vi.restoreAllMocks();
});

function spyLogger() {
  return { info: vi.fn() };
}

describe('readTamsConfig', () => {
  it('reports not-configured when the key is unset', () => {
    delete process.env[TAMS_STORE_URL_ENV];
    expect(readTamsConfig()).toEqual({ configured: false });
  });

  it('reports not-configured for an empty string', () => {
    process.env[TAMS_STORE_URL_ENV] = '';
    expect(readTamsConfig()).toEqual({ configured: false });
  });

  it('reports not-configured for a whitespace-only string', () => {
    process.env[TAMS_STORE_URL_ENV] = '   \t  ';
    expect(readTamsConfig()).toEqual({ configured: false });
  });

  it('reports configured and carries the trimmed gateway base url', () => {
    process.env[TAMS_STORE_URL_ENV] = '  https://tams.example.osc/  ';
    expect(readTamsConfig()).toEqual({
      configured: true,
      config: { gatewayBaseUrl: 'https://tams.example.osc/' }
    });
  });

  it('reads from an injected env source', () => {
    expect(
      readTamsConfig({ [TAMS_STORE_URL_ENV]: 'https://injected.osc' })
    ).toEqual({
      configured: true,
      config: { gatewayBaseUrl: 'https://injected.osc' }
    });
  });
});

describe('gateTamsIndexing — unconfigured branch', () => {
  it('returns skip and emits exactly one structured log line', () => {
    const log = spyLogger();
    const decision = gateTamsIndexing({ configured: false }, log);

    expect(decision).toEqual({ action: 'skip' });
    // A single structured line: (object of fields, message string).
    expect(log.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = log.info.mock.calls[0]!;
    expect(fields).toEqual({ env: TAMS_STORE_URL_ENV });
    expect(typeof msg).toBe('string');
    expect(msg).toMatch(/not configured/i);
  });

  it('does not throw when no logger is supplied', () => {
    expect(() => gateTamsIndexing({ configured: false })).not.toThrow();
  });
});

describe('gateTamsIndexing — configured branch', () => {
  it('returns proceed carrying the gateway base url and logs nothing', () => {
    const log = spyLogger();
    const decision = gateTamsIndexing(
      { configured: true, config: { gatewayBaseUrl: 'https://tams.osc' } },
      log
    );

    expect(decision).toEqual({
      action: 'proceed',
      config: { gatewayBaseUrl: 'https://tams.osc' }
    });
    // The normal (configured) path stays quiet — no skip log line.
    expect(log.info).not.toHaveBeenCalled();
  });
});

describe('resolveTamsGate — end to end over process.env', () => {
  it('unset TAMS_STORE_URL -> skip, one log line, no throw', () => {
    delete process.env[TAMS_STORE_URL_ENV];
    const log = spyLogger();

    const decision = resolveTamsGate(log);

    expect(decision).toEqual({ action: 'skip' });
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('whitespace TAMS_STORE_URL -> skip, one log line', () => {
    process.env[TAMS_STORE_URL_ENV] = '   ';
    const log = spyLogger();

    const decision = resolveTamsGate(log);

    expect(decision).toEqual({ action: 'skip' });
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('present TAMS_STORE_URL -> proceed carrying the gateway base url, no log', () => {
    process.env[TAMS_STORE_URL_ENV] = 'https://tams.example.osc';
    const log = spyLogger();

    const decision = resolveTamsGate(log);

    expect(decision).toEqual({
      action: 'proceed',
      config: { gatewayBaseUrl: 'https://tams.example.osc' }
    });
    expect(log.info).not.toHaveBeenCalled();
  });
});
