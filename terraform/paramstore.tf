############################
# Parameter store (app config) provisioning
#
# Mirrors the verified OSC provider example at
# examples/paramstore/main.tf (osc provider 0.5.0). The
# eyevinn-app-config-svc resource has a MANDATORY redis_url argument
# (example line 101) that must point at a secret backed by a Valkey
# instance. Provisioning the parameter store therefore requires FIVE
# resources, not one:
#   - random_password.valkey_password  (example lines 62-65)
#   - osc_secret.valkeypassword         (example lines 71-79)
#   - osc_valkey_io_valkey.this         (example lines 91-94)
#   - osc_secret.redis_url              (example lines 81-86)
#   - osc_eyevinn_app_config_svc.this   (example lines 99-104)
############################

############################
# Locals
############################
locals {
  # Use the provided password when set, otherwise the generated one.
  # Mirrors example line 47.
  valkey_password_final = var.valkey_password != null && var.valkey_password != "null" ? var.valkey_password : random_password.valkey_password.result

  # Redis connection URL built from the Valkey instance coordinates.
  # Mirrors example line 48.
  valkey_redis_url = format("redis://default:%s@%s:%d", local.valkey_password_final, osc_valkey_io_valkey.this.external_ip, osc_valkey_io_valkey.this.external_port)
}

############################
# Resource: Random password
# example lines 62-65
############################
resource "random_password" "valkey_password" {
  length  = 16
  special = false
}

############################
# Resource: Secrets
# example lines 71-86
############################
resource "osc_secret" "valkeypassword" {
  service_ids  = ["valkey-io-valkey"]
  secret_name  = "${var.paramstore_name}valkeypassword"
  secret_value = local.valkey_password_final

  lifecycle {
    create_before_destroy = true
  }
}

resource "osc_secret" "redis_url" {
  service_ids  = ["eyevinn-app-config-svc"]
  secret_name  = "${var.paramstore_name}redisurl"
  secret_value = local.valkey_redis_url
  depends_on   = [osc_valkey_io_valkey.this]
}

############################
# Resource: Valkey
# example lines 91-94
############################
resource "osc_valkey_io_valkey" "this" {
  name     = var.paramstore_name
  password = format("{{secrets.%s}}", osc_secret.valkeypassword.secret_name)
}

############################
# Resource: App Config Service (parameter store)
# example lines 99-104
############################
resource "osc_eyevinn_app_config_svc" "this" {
  name      = var.paramstore_name
  redis_url = format("{{secrets.%s}}", osc_secret.redis_url.secret_name)

  depends_on = [osc_valkey_io_valkey.this, osc_secret.redis_url]
}
