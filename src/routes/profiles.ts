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

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ProfileExistsError,
  isValidProfileName,
  type ProfileRepository
} from '../data/profile-repo.js';
import { bootstrapProfiles } from '../services/profile-bootstrap.js';

export type ProfilesRouterOptions = {
  // Profile repository (CouchDB-backed per-workspace in production).
  repository: ProfileRepository;
  // The default Encore profile index URL used to seed the DB on bootstrap.
  bootstrapIndexUrl: string;
};

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const profileSchema = z.object({
  name: z.string(),
  yaml: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

// The list response keeps the historical `profiles: string[]` (sorted names,
// "none" excluded) for the existing UI picker, and adds `items` with the full
// profile objects for management views.
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
  skipped: z.boolean()
});

export const profilesRouter: FastifyPluginAsync<ProfilesRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository;

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
      const items = await repo.list();
      const profiles = items
        .map((p) => p.name)
        .filter((name) => name !== 'none')
        .sort((a, b) => a.localeCompare(b));
      return reply.code(200).send({ profiles, items });
    }
  );

  // Public Encore-format profile index. Served WITHOUT authentication so the
  // Encore instances the scaler spawns can fetch it directly. Each stored
  // profile maps its name to a relative URL of the per-profile YAML document
  // (`:name/yaml`), which Encore resolves against this endpoint's base URL.
  app.get(
    '/index.yml',
    {
      schema: {
        response: {
          200: z.string()
        }
      }
    },
    async (_request, reply) => {
      const items = await repo.list();
      const lines = items
        .map((p) => p.name)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => `${name}: ${name}/yaml`);
      reply.header('content-type', 'text/yaml; charset=utf-8');
      return reply.code(200).send(lines.join('\n') + (lines.length > 0 ? '\n' : ''));
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
        response: { 201: profileSchema, 400: errorSchema, 409: errorSchema }
      }
    },
    async (request, reply) => {
      if (!isValidProfileName(request.body.name)) {
        return reply.code(400).send({
          error: 'invalid_name',
          message: 'profile name may contain only letters, digits, dot, dash and underscore'
        });
      }
      const profile = await repo.create(request.body);
      return reply.code(201).send(profile);
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
      return reply.code(200).send(profile);
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
    async (request, reply) => {
      const profile = await repo.get(request.params.name);
      if (!profile) {
        return reply.code(404).send({ error: 'not_found' });
      }
      reply.header('content-type', 'text/yaml; charset=utf-8');
      return reply.code(200).send(profile.yaml);
    }
  );

  // Replace a profile's YAML content.
  app.put(
    '/:name',
    {
      schema: {
        params: z.object({ name: z.string() }),
        body: updateBodySchema,
        response: { 200: profileSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const updated = await repo.update(request.params.name, request.body.yaml);
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(updated);
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
      return reply.code(204).send(null);
    }
  );
};
