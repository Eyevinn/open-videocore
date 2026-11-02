// Encore transcoding profile catalogue + management API (issue #84).
//
// Encore loads its available transcoding profiles from a YAML index file whose
// URL is configured via `profilesUrl` on the OSC Encore service instance. The
// index is a flat map of profile name -> filename, e.g.:
//   program: program.yml
//   program-x265: program-x265.yml
//   archive: archive.yml
// The profile *names* (the keys) are what get submitted as `profile` in an
// Encore job.
//
// Profiles were previously read at runtime from a remote YAML index. They are
// now persisted in CouchDB (per-tenant) and surfaced/managed here:
//   GET    /                — list profile names (picker) + full profiles
//   POST   /                — create { name, yaml }
//   GET    /:name           — get one { name, yaml, ... }
//   PUT    /:name           — replace { yaml }
//   DELETE /:name           — remove
//   POST   /bootstrap       — seed from the default Encore profile index
//   GET    /index.yml       — public Encore-format index (name: :name/yaml), no auth
//   GET    /stacks/:stack/index.yml   — the SAME index, resolved against the
//                             named stack's profile store (issue #1164), no auth
//   GET    /stacks/:stack/:name/yaml  — per-profile YAML on the named stack
//
// STACK SCOPING (issue #1164). The profile store is per stack: `repository` is
// the PerWorkspaceProfileRepository, which resolves the stack of the IN-FLIGHT
// REQUEST (src/data/per-workspace-repos.ts:362-366 ->
// currentRequestStackName()) and falls back to the FIRST listed stack when the
// request named none (src/services/workspace-stack.ts `resolve()`, no-stackName
// branch). Every browser/API caller names its stack with `X-Stack-Name`, but
// Encore does not: each spawned instance fetches its `profilesUrl` with a
// plain, header-less, tokenless GET (src/encore-scaler/instance-pool.ts:604-608).
// So on a multi-stack install EVERY stack's Encore read the FIRST stack's
// profile store, and a profile created against stack 2 was invisible to stack
// 2's own transcodes ("Could not find location for profile ...").
//
// The stack therefore has to travel in the URL, which is the only thing the
// spawned instance carries. It is a PATH prefix (not a query parameter) because
// Encore resolves each index entry as a RELATIVE reference against the index
// URL: under `/stacks/:stack/index.yml`, the entry `program: program/yaml`
// resolves to `/stacks/:stack/program/yaml` and stays on the same stack, while a
// `?stack=` query would be dropped by that relative resolution and silently
// send the per-profile fetch back to the first stack.
//
// This whole router is unauthenticated by design (matching the pre-change
// public profiles endpoint and Encore's own profile fetch): OSC terminates auth
// at the edge (ADR-003) and index.yml MUST be reachable by the Encore instances
// the scaler spawns without a bearer token.
//
// Contracts fetched before writing (CLAUDE.md rule 7):
//   - src/data/profile-repo.ts — ProfileRepository CRUD signatures, Profile
//     shape, ProfileExistsError, isValidProfileName.
//   - src/services/profile-bootstrap.ts — bootstrapProfiles({ repository,
//     indexUrl, force, log }) -> { seeded, skipped }.
//   - src/routes/collections.ts — Fastify ZodTypeProvider CRUD + setErrorHandler
//     template.
//   - src/data/per-workspace-repos.ts:362-366 — PerWorkspaceProfileRepository
//     resolves `currentRequestStackName()` per call (issue #1164).
//   - src/services/request-stack-context.ts — `runWithRequestedStack`,
//     `normaliseStackName` (the untrusted-name boundary).
//   - src/pipeline/profile-level-fit.ts — `levelSafeProfileYaml(yaml: string):
//     string` (pure, never throws, returns its input when nothing needs fitting),
//     applied on the per-profile YAML read path (issue #1167 review, finding 3).

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ProfileExistsError,
  isValidProfileName,
  type ProfileRepository
} from '../data/profile-repo.js';
import { bootstrapProfiles } from '../services/profile-bootstrap.js';
import { isProfileRunnable } from '../services/profile-runnability.js';
import { validateProfileColourSignalling } from '../pipeline/profile-colour-guard.js';
import { levelSafeProfileYaml } from '../pipeline/profile-level-fit.js';
import {
  normaliseStackName,
  runWithRequestedStack
} from '../services/request-stack-context.js';

export type ProfilesRouterOptions = {
  // Profile repository (CouchDB-backed per-workspace in production).
  repository: ProfileRepository;
  // The default Encore profile index URL used to seed the DB on bootstrap.
  bootstrapIndexUrl: string;
  // Called after EVERY successful mutation of the profile store
  // (create/update/delete/bootstrap) so the object-store-published profile index
  // can be republished (ADR-026 D1, issue #1207 — see
  // src/services/profile-index-publisher.ts). Optional: a deployment with no
  // provisioned object store simply omits it.
  //
  // Contract: synchronous, non-throwing and fire-and-forget. The handlers below
  // invoke it AFTER the mutation has been persisted and never await it, so the
  // FIXED HTTP contract of this router — status codes, bodies, the
  // `x-profile-count` header (#460) and the `{}`-for-empty index body (#459) —
  // is unaffected by publish latency or publish failure (ADR-026 §6).
  onProfilesChanged?: () => void;
};

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const profileSchema = z.object({
  name: z.string(),
  yaml: z.string(),
  // Whether this profile can execute on the running Encore instances on this
  // platform tier (issue #286). False for GPU-only (NVENC/CUDA) profiles, which
  // cannot run on OSC's CPU-only Encore instances. Callers/UI MUST NOT offer a
  // non-runnable profile as selectable; a transcode naming one is rejected 422.
  runnable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});

// The list response keeps the historical `profiles: string[]` (sorted names,
// "none" excluded) for the existing UI picker — now further narrowed to the
// RUNNABLE selectable set (GPU-only profiles removed) so callers never pick a
// profile that cannot execute (issue #286). `items` carries the full profile
// objects (each annotated with `runnable`) for management views, so operators
// can still see the excluded GPU-only profiles flagged unrunnable.
const listResponseSchema = z.object({
  profiles: z.array(z.string()),
  items: z.array(profileSchema)
});

const createBodySchema = z.object({
  name: z.string().min(1).max(128),
  yaml: z.string().min(1)
});

const updateBodySchema = z.object({
  yaml: z.string().min(1)
});

const bootstrapResponseSchema = z.object({
  seeded: z.number(),
  skipped: z.boolean(),
  // Count of built-in profiles newly created this run (issue #385).
  builtinSeeded: z.number()
});

export const profilesRouter: FastifyPluginAsync<ProfilesRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository;

  // Fire-and-forget republish notification (ADR-026 D1). Wrapped so a throwing
  // callback can never turn a successful profile mutation into a 500 — the
  // published index is a derived artefact, the store is the source of truth.
  const notifyProfilesChanged = (): void => {
    try {
      opts.onProfilesChanged?.();
    } catch (err) {
      app.log.warn({ err }, 'profile index republish notification failed (ignored)');
    }
  };

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof ProfileExistsError) {
      return reply.code(err.statusCode).send({ error: 'conflict', message: err.message });
    }
    throw err;
  });

  // List profiles. Names (sorted, "none" excluded) for the picker + full items.
  app.get(
    '/',
    { schema: { response: { 200: listResponseSchema } } },
    async (_request, reply) => {
      const stored = await repo.list();
      const items = stored.map((p) => ({ ...p, runnable: isProfileRunnable(p.yaml) }));
      // The picker only offers profiles that can actually execute on this
      // platform: "none" excluded (historical) AND GPU-only profiles excluded
      // (issue #286) so a caller cannot select an unrunnable profile.
      const profiles = items
        .filter((p) => p.name !== 'none' && p.runnable)
        .map((p) => p.name)
        .sort((a, b) => a.localeCompare(b));
      return reply.code(200).send({ profiles, items });
    }
  );

  // The ONE rendering of the Encore-format index response, shared by the
  // unscoped route and the stack-scoped route (issue #1164) so the FIXED
  // contract — 200, `text/yaml`, the `x-profile-count` header (#460), `{}\n` on
  // an empty store (#459/#461) and the `name: name/yaml` relative entries —
  // cannot drift between the two. It reads the profile store that is ambient for
  // the caller, which is this request's stack.
  const sendIndexYml = async (reply: FastifyReply) => {
    const items = await repo.list();
    // GPU-only (NVENC/CUDA) profiles are excluded from the Encore-facing index
    // (issue #286): the CPU-only Encore instances the scaler spawns must not
    // load a profile they cannot execute.
    const lines = items
      .filter((p) => isProfileRunnable(p.yaml))
      .map((p) => p.name)
      .sort((a, b) => a.localeCompare(b))
      // Relative to THIS index's own URL, so the per-profile fetch stays on the
      // same stack-scoped prefix the index was served under (issue #1164).
      .map((name) => `${name}: ${name}/yaml`);
    reply.header('content-type', 'text/yaml; charset=utf-8');
    // Expose the runnable-profile count as a response header so monitoring
    // consumers can alert on an empty store WITHOUT parsing the YAML body,
    // and WITHOUT changing the fixed 200/body contract the headerless Encore
    // YAML consumer depends on (issue #460). The count is exactly `lines.length`
    // — the number of profile entries actually written to the body (runnable
    // profiles after the `isProfileRunnable` filter), so header and body always
    // agree: `0` iff the body is the empty mapping `{}`.
    reply.header('x-profile-count', String(lines.length));
    // An empty list must still be a valid YAML mapping. A zero-byte body makes
    // downstream YAML parsers fail with "No content to map due to end-of-input",
    // so emit an empty mapping (`{}`) instead (issue #459).
    if (lines.length === 0) {
      return reply.code(200).send('{}\n');
    }
    return reply.code(200).send(lines.join('\n') + '\n');
  };

  // The ONE rendering of a single profile's raw YAML, shared by the unscoped and
  // stack-scoped routes (issue #1164).
  //
  // This is the document the transcoding service itself fetches (each index
  // entry resolves to `:name/yaml`), so the level-safe bounding widths are
  // applied HERE rather than only when a profile is seeded (issue #1167 review,
  // finding 3). A height-only rung that declares an H.264 level is served with
  // its bounding width added, which is what keeps an approximately-16:9 source
  // inside the level the profile declares — whether that rung arrived from the
  // remote index, from `POST /`, or from `PUT /:name`. The STORED document is
  // untouched: the management reads (`GET /`, `GET /:name`) still return exactly
  // what the operator authored. `levelSafeProfileYaml` never throws and returns
  // its input unchanged when there is nothing to fit, so the response contract
  // (200, `text/yaml`, 404 for unknown) is unchanged.
  const sendProfileYaml = async (name: string, reply: FastifyReply) => {
    const profile = await repo.get(name);
    if (!profile) {
      return reply.code(404).send({ error: 'not_found' });
    }
    reply.header('content-type', 'text/yaml; charset=utf-8');
    return reply.code(200).send(levelSafeProfileYaml(profile.yaml));
  };

  // Public Encore-format profile index. Served WITHOUT authentication so the
  // Encore instances the scaler spawns can fetch it directly. Each stored
  // profile maps its name to a relative URL of the per-profile YAML document
  // (`:name/yaml`), which Encore resolves against this endpoint's base URL.
  app.get(
    '/index.yml',
    {
      schema: {
        // Machine-readable profile-count signal for monitoring consumers (issue
        // #460). The `/index.yml` body/status contract is FIXED by a downstream
        // headerless YAML consumer, so an empty store still returns 200 with a
        // valid YAML mapping (`{}` — issue #459) and cannot itself signal "zero
        // profiles vs. something wrong". A monitoring probe therefore reads the
        // `x-profile-count` RESPONSE HEADER (the number of runnable profiles in
        // the emitted index) and can alert on `0` WITHOUT parsing the YAML.
        description:
          'Public Encore-format profile index (name -> :name/yaml). Served without auth. ' +
          'Response header `x-profile-count` carries the number of runnable profiles ' +
          'in the emitted index so monitoring consumers can distinguish an empty store ' +
          '(x-profile-count: 0, body `{}`) from a failure WITHOUT parsing the YAML body. ' +
          'The body and 200 status are unchanged by this header (issue #460).',
        response: {
          200: z.string()
        }
      }
    },
    async (_request, reply) => sendIndexYml(reply)
  );

  // The SAME public index, resolved against the profile store of the stack named
  // in the path (issue #1164). This is the URL handed to every scaler-spawned
  // Encore instance on a deployment that serves its own index
  // (`stackScopedProfilesIndexUrl`, src/services/public-base-url.ts), because a
  // spawned instance fetches its `profilesUrl` with no `X-Stack-Name` header and
  // would otherwise read the FIRST listed stack's profiles whatever stack it
  // belongs to.
  //
  // The path segment is an UNTRUSTED string exactly like the header is, so it
  // enters through `normaliseStackName` + `runWithRequestedStack`: it ROUTES
  // this request's repository resolution and is never persistable (issue #1097
  // review, BLOCKING 2). A syntactically valid name with no stored config
  // resolves to the workspace default, exactly as the header does
  // (src/services/workspace-stack.ts `resolve()`), so a single-stack deployment
  // whose scaler key is not itself a stack name keeps today's behaviour. A name
  // that cannot name a stack at all is a 400 rather than a silent default: this
  // URL is generated by this app, so a malformed one is a defect to surface, not
  // a stale UI selection to tolerate.
  app.get(
    '/stacks/:stack/index.yml',
    {
      schema: {
        params: z.object({ stack: z.string() }),
        description:
          'Public Encore-format profile index for ONE stack (name -> :name/yaml), served ' +
          'without auth. Identical body/status/`x-profile-count` contract to ' +
          'GET /api/v1/profiles/index.yml, but resolved against the named stack\'s profile ' +
          'store so an Encore instance belonging to that stack reads the profiles created ' +
          'on it, whatever its position in the stack listing (issue #1164). Index entries ' +
          'are relative, so each per-profile fetch stays on this stack-scoped prefix.',
        response: { 200: z.string(), 400: errorSchema }
      }
    },
    async (request, reply) => {
      const stackName = normaliseStackName(request.params.stack);
      if (!stackName) {
        return reply.code(400).send({
          error: 'invalid_stack_name',
          message: 'stack name may contain only lowercase letters, digits and hyphens'
        });
      }
      return runWithRequestedStack(stackName, () => sendIndexYml(reply));
    }
  );

  // Per-profile YAML on the named stack. Target of the relative entries emitted
  // by GET /stacks/:stack/index.yml above (issue #1164), so Encore resolves each
  // profile document against the same stack it read the index from.
  app.get(
    '/stacks/:stack/:name/yaml',
    {
      schema: {
        params: z.object({ stack: z.string(), name: z.string() }),
        description:
          "One profile's raw YAML from the named stack's profile store, served without " +
          'auth. Target of the relative entries in GET /api/v1/profiles/stacks/{stack}/index.yml ' +
          '(issue #1164).',
        response: { 200: z.string(), 400: errorSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const stackName = normaliseStackName(request.params.stack);
      if (!stackName) {
        return reply.code(400).send({
          error: 'invalid_stack_name',
          message: 'stack name may contain only lowercase letters, digits and hyphens'
        });
      }
      return runWithRequestedStack(stackName, () =>
        sendProfileYaml(request.params.name, reply)
      );
    }
  );

  // Seed the DB from the default Encore profile index. Idempotent: skips when
  // profiles already exist unless `?force=true` is passed.
  app.post(
    '/bootstrap',
    {
      schema: {
        querystring: z.object({ force: z.coerce.boolean().optional() }),
        response: { 200: bootstrapResponseSchema, 502: errorSchema }
      }
    },
    async (request, reply) => {
      try {
        const result = await bootstrapProfiles({
          repository: repo,
          indexUrl: opts.bootstrapIndexUrl,
          force: request.query.force ?? false,
          log: app.log
        });
        notifyProfilesChanged();
        return reply.code(200).send(result);
      } catch (err) {
        app.log.warn({ err, indexUrl: opts.bootstrapIndexUrl }, 'profile bootstrap failed');
        return reply.code(502).send({ error: 'bootstrap_failed', message: 'could not fetch the default profile index' });
      }
    }
  );

  // Create a profile.
  app.post(
    '/',
    {
      schema: {
        body: createBodySchema,
        response: { 201: profileSchema, 400: errorSchema, 409: errorSchema, 422: errorSchema }
      }
    },
    async (request, reply) => {
      if (!isValidProfileName(request.body.name)) {
        return reply.code(400).send({
          error: 'invalid_name',
          message: 'profile name may contain only letters, digits, dot, dash and underscore'
        });
      }
      // Reject a profile whose colour signalling is not carriable at its pixel
      // format at registration time (issue #377), so a mistagged profile (e.g.
      // 8-bit tagged PQ) can never enter the store and be selected for an encode.
      const colour = validateProfileColourSignalling(request.body.yaml);
      if (!colour.ok) {
        return reply.code(422).send({ error: 'profile_colour_uncarriable', message: colour.reason });
      }
      const profile = await repo.create(request.body);
      notifyProfilesChanged();
      return reply.code(201).send({ ...profile, runnable: isProfileRunnable(profile.yaml) });
    }
  );

  // Get a single profile.
  app.get(
    '/:name',
    {
      schema: {
        params: z.object({ name: z.string() }),
        response: { 200: profileSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const profile = await repo.get(request.params.name);
      if (!profile) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send({ ...profile, runnable: isProfileRunnable(profile.yaml) });
    }
  );

  // Get a single profile's raw YAML. Referenced by index.yml so Encore can
  // resolve each profile file. Public (no auth), served as text/yaml.
  app.get(
    '/:name/yaml',
    {
      schema: {
        params: z.object({ name: z.string() }),
        response: { 200: z.string(), 404: errorSchema }
      }
    },
    async (request, reply) => sendProfileYaml(request.params.name, reply)
  );

  // Replace a profile's YAML content.
  app.put(
    '/:name',
    {
      schema: {
        params: z.object({ name: z.string() }),
        body: updateBodySchema,
        response: { 200: profileSchema, 404: errorSchema, 422: errorSchema }
      }
    },
    async (request, reply) => {
      // Reject an update that would introduce colour signalling not carriable at
      // the profile's pixel format (issue #377) before it is persisted.
      const colour = validateProfileColourSignalling(request.body.yaml);
      if (!colour.ok) {
        return reply.code(422).send({ error: 'profile_colour_uncarriable', message: colour.reason });
      }
      const updated = await repo.update(request.params.name, request.body.yaml);
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      notifyProfilesChanged();
      return reply.code(200).send({ ...updated, runnable: isProfileRunnable(updated.yaml) });
    }
  );

  // Delete a profile. Idempotent: an unknown name still answers 204.
  app.delete(
    '/:name',
    {
      schema: {
        params: z.object({ name: z.string() }),
        response: { 204: z.null() }
      }
    },
    async (request, reply) => {
      await repo.delete(request.params.name);
      notifyProfilesChanged();
      return reply.code(204).send(null);
    }
  );
};
