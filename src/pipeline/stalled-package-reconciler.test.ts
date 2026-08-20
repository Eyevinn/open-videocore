import { describe, it, expect } from 'vitest';

import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import type { StepExecution } from '../data/pipeline-repo.js';
import {
  reconcileStalledPackages,
  DEFAULT_PACKAGE_STALL_TIMEOUT_MS
} from './stalled-package-reconciler.js';

// Build a running PipelineExecution whose `package` step is `running` with the
// given startedAt — i.e. the exact stuck shape issue #336 describes (a package
// step that only advances via the packager completion callback, which never
// arrived). Returns the repo + the created execution id.
async function stuckPackage(startedAt: string) {
  const pipeline = new InMemoryPipelineRepository();
  const execution = await pipeline.create({
    assetId: 'asset-1',
    pipelineName: 'abr-vod',
    steps: ['transcode', 'package']
  });
  // transcode done, package running (the transcode->package handoff set the
  // package step running and enqueued the packaging job).
  const steps: StepExecution[] = execution.steps.map((s) => ({ ...s }));
  steps[0] = { ...steps[0], status: 'done', completedAt: startedAt };
  steps[1] = { ...steps[1], status: 'running', startedAt };
  await pipeline.update(execution.id, { steps });
  return { pipeline, executionId: execution.id };
}

describe('reconcileStalledPackages', () => {
  it('fails a package step stuck past the bound (packager present => no completion signal)', async () => {
    const startedAt = new Date('2026-08-20T10:00:00.000Z').toISOString();
    const { pipeline, executionId } = await stuckPackage(startedAt);
    const base = Date.parse(startedAt);

    const result = await reconcileStalledPackages({
      pipeline,
      packagerPresent: async () => true,
      now: () => base + DEFAULT_PACKAGE_STALL_TIMEOUT_MS + 1
    });

    expect(result).toEqual({ scanned: 1, failed: 1 });

    const execution = await pipeline.get(executionId);
    expect(execution?.status).toBe('failed');
    const step = execution?.steps.find((s) => s.name === 'package');
    expect(step?.status).toBe('failed');
    expect(step?.completedAt).toBeTruthy();
    // Diagnostic distinguishes the "no completion signal received" cause.
    expect(step?.error).toContain('present=true');
    expect(step?.error).toMatch(/no completion signal/i);
    expect(step?.error).toMatch(/within \d+ minutes/i);
  });

  it('fails a package step stuck past the bound (no packager instance)', async () => {
    const startedAt = new Date('2026-08-20T10:00:00.000Z').toISOString();
    const { pipeline, executionId } = await stuckPackage(startedAt);
    const base = Date.parse(startedAt);

    const result = await reconcileStalledPackages({
      pipeline,
      packagerPresent: async () => false,
      now: () => base + DEFAULT_PACKAGE_STALL_TIMEOUT_MS + 1
    });

    expect(result).toEqual({ scanned: 1, failed: 1 });

    const execution = await pipeline.get(executionId);
    const step = execution?.steps.find((s) => s.name === 'package');
    expect(step?.status).toBe('failed');
    // Diagnostic distinguishes the "no packager instance" cause.
    expect(step?.error).toContain('present=false');
    expect(step?.error).toMatch(/no packager instance/i);
  });

  it('renders present=unknown when the presence probe throws (never blocks the timeout)', async () => {
    const startedAt = new Date('2026-08-20T10:00:00.000Z').toISOString();
    const { pipeline, executionId } = await stuckPackage(startedAt);
    const base = Date.parse(startedAt);

    const result = await reconcileStalledPackages({
      pipeline,
      packagerPresent: async () => {
        throw new Error('OSC unreachable');
      },
      now: () => base + DEFAULT_PACKAGE_STALL_TIMEOUT_MS + 1
    });

    // Still fails within the bound despite the probe failing.
    expect(result).toEqual({ scanned: 1, failed: 1 });
    const execution = await pipeline.get(executionId);
    expect(execution?.steps.find((s) => s.name === 'package')?.status).toBe('failed');
    expect(execution?.steps.find((s) => s.name === 'package')?.error).toContain(
      'present=unknown'
    );
  });

  it('renders present=unknown when no presence probe is wired', async () => {
    const startedAt = new Date('2026-08-20T10:00:00.000Z').toISOString();
    const { pipeline, executionId } = await stuckPackage(startedAt);
    const base = Date.parse(startedAt);

    const result = await reconcileStalledPackages({
      pipeline,
      now: () => base + DEFAULT_PACKAGE_STALL_TIMEOUT_MS + 1
    });

    expect(result).toEqual({ scanned: 1, failed: 1 });
    expect(
      (await pipeline.get(executionId))?.steps.find((s) => s.name === 'package')?.error
    ).toContain('present=unknown');
  });

  it('leaves a package step within the bound running (no premature failure)', async () => {
    const startedAt = new Date('2026-08-20T10:00:00.000Z').toISOString();
    const { pipeline, executionId } = await stuckPackage(startedAt);
    const base = Date.parse(startedAt);

    const result = await reconcileStalledPackages({
      pipeline,
      packagerPresent: async () => true,
      // Only a moment has passed — a healthy in-flight packaging job must not fail.
      now: () => base + 1_000
    });

    expect(result).toEqual({ scanned: 1, failed: 0 });
    const execution = await pipeline.get(executionId);
    expect(execution?.status).toBe('running');
    expect(execution?.steps.find((s) => s.name === 'package')?.status).toBe('running');
  });

  it('respects a custom stallTimeoutMs bound', async () => {
    const startedAt = new Date('2026-08-20T10:00:00.000Z').toISOString();
    const { pipeline } = await stuckPackage(startedAt);
    const base = Date.parse(startedAt);
    const bound = 60_000; // 1 minute

    // Just under the custom bound -> untouched.
    const under = await reconcileStalledPackages({
      pipeline,
      stallTimeoutMs: bound,
      now: () => base + 30_000
    });
    expect(under).toEqual({ scanned: 1, failed: 0 });

    // Just over the custom bound -> failed.
    const over = await reconcileStalledPackages({
      pipeline,
      stallTimeoutMs: bound,
      now: () => base + bound + 1
    });
    expect(over).toEqual({ scanned: 1, failed: 1 });
  });

  it('ignores executions with no running package step', async () => {
    const pipeline = new InMemoryPipelineRepository();
    // A running execution whose transcode step is running (package still pending).
    const exec = await pipeline.create({
      assetId: 'asset-2',
      pipelineName: 'abr-vod',
      steps: ['transcode', 'package']
    });
    const steps: StepExecution[] = exec.steps.map((s) => ({ ...s }));
    steps[0] = { ...steps[0], status: 'running', startedAt: new Date('2020-01-01').toISOString() };
    await pipeline.update(exec.id, { steps });

    const result = await reconcileStalledPackages({
      pipeline,
      now: () => Date.now()
    });

    expect(result).toEqual({ scanned: 0, failed: 0 });
    expect((await pipeline.get(exec.id))?.status).toBe('running');
  });

  it('skips a running package step with no parseable startedAt (cannot be bounded)', async () => {
    const pipeline = new InMemoryPipelineRepository();
    const exec = await pipeline.create({
      assetId: 'asset-3',
      pipelineName: 'abr-vod',
      steps: ['package']
    });
    // package running but startedAt missing -> cannot age it; skip rather than
    // fail a step on ambiguous data.
    const steps: StepExecution[] = exec.steps.map((s) => ({ ...s, status: 'running' as const }));
    await pipeline.update(exec.id, { steps });

    const result = await reconcileStalledPackages({
      pipeline,
      now: () => Date.now() + DEFAULT_PACKAGE_STALL_TIMEOUT_MS * 10
    });

    // Scanned (a running package step exists) but not failed (unbounded).
    expect(result).toEqual({ scanned: 1, failed: 0 });
    expect((await pipeline.get(exec.id))?.steps[0].status).toBe('running');
  });
});
