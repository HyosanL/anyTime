terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_account_id" {
  type = string
}

variable "cloudflare_zone_id" {
  description = "Zone ID for anytime.rokafa.app"
  type        = string
}

variable "turnstile_domains" {
  type    = list(string)
  default = ["anytime.rokafa.app", "anytime-dzi.pages.dev", "localhost"]
}
