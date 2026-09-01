############################
# Variables (inputs)
############################

## --- General ---

# Your OSC Personal Access Token (PAT). Sensitive.
variable "osc_pat" {
  type        = string
  sensitive   = true
  description = "Eyevinn OSC Personal Access Token"
}

# Environment: prod | stage | dev
variable "osc_environment" {
  type        = string
  default     = "prod"
  description = "OSC Environment"
}

## --- Instance naming ---

variable "paramstore_name" {
  type        = string
  default     = "ovcconfig"
  description = "Name of the parameter store (app config) solution. Lower case letters and numbers only"
}

variable "open_videocore_name" {
  type        = string
  description = "Name of the open-videocore instance. Lower case letters and numbers only"
}

## --- Parameter store credentials ---
#
# The open-videocore instance (#485) requires PARAMETER_STORE_API_KEY, which
# README.md:125 defines as the "ConfigApiKey of the eyevinn-app-config-svc
# instance". The verified OSC provider example (osc 0.5.0,
# examples/paramstore/main.tf outputs lines 125-136) exposes ONLY external_ip,
# external_port, instance_url, and service_id for osc_eyevinn_app_config_svc —
# there is NO ConfigApiKey attribute/output, and no companion osc_* data source
# exists in the verified examples tree. Terraform therefore cannot derive the
# key; it must be obtained out-of-band (see terraform/PARAMETER_STORE_API_KEY.md)
# and passed in.
variable "parameter_store_api_key" {
  type        = string
  sensitive   = true
  description = "ConfigApiKey of the eyevinn-app-config-svc instance (README.md:125). Obtained out-of-band; see terraform/PARAMETER_STORE_API_KEY.md. Consumed as PARAMETER_STORE_API_KEY by the open-videocore instance (#485)."
}

## --- Valkey (backing store for the parameter store) ---

variable "valkey_password" {
  type        = string
  default     = null
  sensitive   = true
  nullable    = true
  description = "Password for the Valkey instance backing the parameter store. Leave null to auto-generate"
}
