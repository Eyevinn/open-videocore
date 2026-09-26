// Discriminated runner-or-factory options (issue #838).
//
// Three asset routes (thumbnail, re-wrap, clip) accept EITHER a ready-to-call
// runner OR a factory that builds one from the workspace's MinIO credentials.
// Production injects factories (the OSC ffmpeg-s3 job writes its output to
// `s3://bucket/key` natively, so the runner needs the credentials + bucket in
// the job body — a presigned PUT URL does not work with the image2/output muxer,
// issues #92 and #316). Tests inject plain runners and no s3Config.
//
// The previous shape was `T | ((s3) => T)` discriminated at each call site with
// `typeof opts.x === 'function' && s3Config`. That test cannot tell the two
// apart: a runner and a factory are BOTH `function`, so the branch hinged
// entirely on s3Config being present. On a stack that resolves without an
// s3Config (workspace-stack.ts:371, the in-memory connections) the factory was
// invoked AS the runner — it returned a function, `await` resolved it, and no
// OSC job was ever dispatched.
//
// Here the factory is an OBJECT with a literal `kind` tag, so the two arms are
// structurally disjoint and the compiler — not a runtime heuristic — decides the
// branch. A factory with no resolvable s3Config is an explicit error rather than
// a call that quietly resolves to nothing.

// Every runner this wraps is a function, which is what makes the object-shaped
// factory arm unambiguous.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRunner = (...args: any[]) => unknown;

// MinIO coordinates a runner factory needs to emit `s3://bucket/key` output.
// `endpoint`/`accessKey`/`secretKey` come from the resolved workspace stack
// (WorkspaceConnections.s3Config, src/services/workspace-stack.ts:118); `bucket`
// is the stack's source bucket (WorkspaceConnections.sourceBucket, same file).
export type RunnerS3Config = {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
};

// The factory arm. Tagged with a literal `kind` so it is disjoint from any
// runner function type.
export type RunnerFactory<T extends AnyRunner> = {
  kind: 'factory';
  make: (s3: RunnerS3Config) => T;
};

// A route/service option that is either the runner itself or a factory for it.
export type RunnerOption<T extends AnyRunner> = T | RunnerFactory<T>;

// Wrap a factory function in the tagged shape. Call sites that build a runner
// from workspace credentials use this instead of passing a bare closure.
export function runnerFactory<T extends AnyRunner>(
  make: (s3: RunnerS3Config) => T
): RunnerFactory<T> {
  return { kind: 'factory', make };
}

export function isRunnerFactory<T extends AnyRunner>(
  option: RunnerOption<T>
): option is RunnerFactory<T> {
  return (
    typeof option === 'object' &&
    option !== null &&
    'kind' in option &&
    (option as RunnerFactory<T>).kind === 'factory'
  );
}

// Thrown when an option is a factory but the request/stack resolved no
// s3Config, so there are no credentials to build the runner from. Distinct
// class (not a bare Error) so callers can map it to their own "not configured"
// response without string-matching a message: the asset routes answer 501, and
// the fire-and-forget pipeline/upload paths log it at error level. Either way
// the failure is explicit instead of a no-op dispatch.
export class RunnerFactoryUnresolvedError extends Error {
  readonly optionName: string;

  constructor(optionName: string) {
    super(
      `${optionName} is configured as a factory but the resolved workspace stack has no s3Config, ` +
        'so no runner could be built and no job would be dispatched'
    );
    this.name = 'RunnerFactoryUnresolvedError';
    this.optionName = optionName;
  }
}

// Build the factory input from the pieces the resolved stack exposes. Returns
// undefined when the stack has no s3Config — the caller decides whether that is
// fatal (it is, for a factory) or irrelevant (it is, for a plain runner).
export function runnerS3Config(
  s3Config: { endpoint: string; accessKey: string; secretKey: string } | undefined,
  bucket: string
): RunnerS3Config | undefined {
  return s3Config ? { ...s3Config, bucket } : undefined;
}

// The single resolution point for all three options. A plain runner passes
// through untouched (so existing callers and tests that inject one keep
// working, with or without an s3Config); a factory is invoked with the
// credentials, or throws RunnerFactoryUnresolvedError when there are none.
export function resolveRunnerOption<T extends AnyRunner>(
  option: RunnerOption<T>,
  s3: RunnerS3Config | undefined,
  optionName: string
): T {
  if (!isRunnerFactory(option)) {
    return option;
  }
  if (!s3) {
    throw new RunnerFactoryUnresolvedError(optionName);
  }
  return option.make(s3);
}
