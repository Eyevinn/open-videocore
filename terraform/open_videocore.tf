############################
# open-videocore instance provisioning
#
# Mirrors README Quick start step 3. Argument names are the EXACT snake_case
# arguments of the osc_eyevinn_open_videocore resource as introspected from the
# verified provider contract:
#   - OSC get-service-schema (serviceId eyevinn-open-videocore): config options
#     name / OscAccessToken / ParameterStoreApiKey / ParameterStore /
#     MinioRootPassword / CouchdbAdminPassword (+ optional Encore* options).
#   - Terraform provider docs, EyevinnOSC/osc resource
#     osc_eyevinn_open_videocore (provider 0.9.0 — the first version to ship this
#     resource; versions.tf is bumped to 0.9.0 accordingly):
#       Required: name, osc_access_token, parameter_store_api_key,
#                 parameter_store, minio_root_password, couchdb_admin_password
#       Optional: encore_idle_timeout_ms, encore_max_instances,
#                 encore_min_instances
#       Read-Only: external_ip, external_port, instance_url, service_id
#
# README env-var -> provider argument mapping (verified, NOT assumed):
#   OSC_ACCESS_TOKEN              -> osc_access_token
#   PARAMETER_STORE_API_KEY       -> parameter_store_api_key
#   PARAMETER_STORE_INSTANCE_NAME -> parameter_store   (the ParameterStore config
#                                    option is the app-config-svc instance name;
#                                    there is NO *_instance_name argument)
#   MINIO_ROOT_PASSWORD           -> minio_root_password    (random_password)
#   COUCHDB_ADMIN_PASSWORD        -> couchdb_admin_password (random_password)
#
# MinIO, CouchDB, Valkey, Encore, callback listeners and the packager are NOT
# provisioned by Terraform: open-videocore creates them at runtime via
# POST /api/v1/provision (README). Only this middleware instance is declared.
############################

############################
# Resource: Generated secrets
############################
resource "random_password" "minio_root_password" {
  length  = 24
  special = false
}

resource "random_password" "couchdb_admin_password" {
  length  = 24
  special = false
}

############################
# Resource: open-videocore instance
############################
resource "osc_eyevinn_open_videocore" "this" {
  name = var.open_videocore_name

  # PAT the instance uses to provision storage/db/queue/transcoders on your
  # behalf. Reuses the module PAT (var.osc_pat); OSC injects it automatically at
  # deploy time per README, but the argument is required by the provider.
  osc_access_token = var.osc_pat

  # Parameter store (app-config-svc) wiring. parameter_store is the instance
  # NAME (README PARAMETER_STORE_INSTANCE_NAME); take it from the applied
  # resource so it tracks var.paramstore_name.
  parameter_store         = osc_eyevinn_app_config_svc.this.name
  parameter_store_api_key = var.parameter_store_api_key

  # Admin passwords used when open-videocore provisions MinIO / CouchDB.
  minio_root_password    = random_password.minio_root_password.result
  couchdb_admin_password = random_password.couchdb_admin_password.result

  depends_on = [osc_eyevinn_app_config_svc.this]
}
