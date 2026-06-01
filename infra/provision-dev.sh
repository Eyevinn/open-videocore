#!/usr/bin/env bash
# Provision OSC dev-tier instances for open-videocore.
# All connection strings land in the 'openvideocore' parameter store.
# Run via the OSC MCP CLI or adapt for your provisioning tool of choice.
set -euo pipefail

echo "open-videocore: OSC dev provisioning"
echo "See docs/deploys/day-1.md for the completed Day-1 deploy audit trail."
echo ""
echo "Services required (already provisioned on Day-1):"
echo "  minio-minio          -> openvideocore"
echo "  apache-couchdb       -> openvideocore"
echo "  birme-osc-postgresql -> openvideocore"
echo "  valkey-io-valkey     -> openvcvalkey"
echo "  encore               -> openvideocore"
echo "  eyevinn-encore-callback-listener -> openvideocore"
echo "  eyevinn-encore-packager          -> openvideocore"
echo ""
echo "Parameter store: openvideocore"
echo "  MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY"
echo "  COUCHDB_URL, COUCHDB_USER, COUCHDB_PASSWORD"
echo "  DATABASE_URL"
echo "  REDIS_URL"
echo "  ENCORE_URL, ENCORE_CALLBACK_URL"
echo ""
echo "To re-provision from scratch, delete all instances in the OSC console"
echo "and re-run the Day-1 deploy plan from ADR-001."
