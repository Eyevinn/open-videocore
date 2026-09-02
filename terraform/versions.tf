terraform {
  required_version = ">= 1.6.0" # Compatible with Terraform >= 1.6.0 and OpenTofu >= 1.6.0
  required_providers {
    osc = {
      # 0.9.0 is the first provider version to ship the
      # osc_eyevinn_open_videocore resource (#485). All resources already used
      # by this module (osc_eyevinn_app_config_svc, osc_valkey_io_valkey,
      # osc_secret) are unchanged in 0.9.0, so this bump is additive.
      source  = "registry.terraform.io/EyevinnOSC/osc"
      version = "0.9.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.0.0"
    }
  }
}

############################
# Provider
############################
provider "osc" {
  pat         = var.osc_pat
  environment = var.osc_environment
}
