# =============================================================================
#  Cloudflare zone hardening for anytime.rokafa.app  (Pages app + /api/*)
#  Firestore / Cloud Functions / Auth traffic does NOT pass through this zone —
#  it is defended by Firebase App Check, not here.
#
#  ⚠️ ALREADY APPLIED via the Cloudflare API on 2026-09-07 (rulesets below are
#     live on zone b4c035a5f9ac9b941be9b9c89455a020). This file is kept as the
#     source of record / for future `terraform import`. If you adopt Terraform,
#     import the existing rulesets first:
#       terraform import cloudflare_ruleset.ratelimit  zone/<ZONE_ID>/<RL_RULESET_ID>
#       terraform import cloudflare_ruleset.custom_fw   zone/<ZONE_ID>/<FW_RULESET_ID>
#     (RL_RULESET_ID = e81b8ae547024de080a758ea8dae01fe,
#      FW_RULESET_ID = cea4307af84943018ba1c2c490ffc7ba as of 2026-09-07)
#
#  Free plan limits (measured on this zone 2026-09-07): rate limiting rule
#  period AND mitigation_timeout are locked to 10 seconds, action block only,
#  1 rule. WAF custom rules: up to 5, all actions but Log.
#
#  `terraform plan` is the syntax gate — the cloudflare provider's `rules`
#  object shape shifts between patch releases. If plan errors on a rule field,
#  cross-check the resource docs, or use the API/dashboard steps in README.md.
# =============================================================================

# --- 1. Rate limiting: the single free-plan rule, on write-ish /api POSTs ---
resource "cloudflare_ruleset" "ratelimit" {
  zone_id     = var.cloudflare_zone_id
  name        = "default"
  description = ""
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [{
    ref         = "api_post_per_ip"
    description = "anytime: block IPs exceeding 10 POST /api/* per 10s"
    expression  = "(starts_with(http.request.uri.path, \"/api/\") and http.request.method eq \"POST\")"
    action      = "block"
    ratelimit = {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 10
      requests_per_period = 10
      mitigation_timeout  = 10
    }
  }]
}

# --- 2. WAF custom rules ---
# Rules 3/4 from the original design (managed_challenge on /api/*) were DROPPED:
# every /api/* request is fetch/XHR, and a browser cannot solve an inline
# challenge, so a flagged-IP or overseas user would get permanently-broken
# image loading. The threat-score rule now only challenges top-level page loads
# (score > 50), so the cf_clearance cookie it earns propagates to later fetches.
# Non-KR abuse is covered by rule 1 (auth required) + the rate limit + the
# Firebase-side per-uid limits + App Check.
resource "cloudflare_ruleset" "custom_fw" {
  zone_id     = var.cloudflare_zone_id
  name        = "default"
  description = ""
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      ref         = "api_requires_auth"
      description = "anytime: block /api/* POST with no Authorization header (secret-gated webhooks excluded)"
      expression  = "(starts_with(http.request.uri.path, \"/api/\") and http.request.method eq \"POST\" and not len(http.request.headers[\"authorization\"][0]) > 0 and not http.request.uri.path in {\"/api/board-sweep\" \"/api/push-fanout\"})"
      action      = "block"
    },
    {
      ref         = "block_weird_methods"
      description = "anytime: block non-standard HTTP methods"
      expression  = "(not http.request.method in {\"GET\" \"POST\" \"HEAD\" \"OPTIONS\"})"
      action      = "block"
    },
    {
      ref         = "challenge_high_threat_pageload"
      description = "anytime: managed challenge very-high-threat page loads (not /api, not assets)"
      expression  = "(cf.threat_score gt 50 and http.request.method eq \"GET\" and not starts_with(http.request.uri.path, \"/api/\") and not starts_with(http.request.uri.path, \"/assets/\") and not starts_with(http.request.uri.path, \"/icons/\") and http.request.uri.path ne \"/sw.js\" and http.request.uri.path ne \"/push-sw.js\")"
      action      = "managed_challenge"
    },
  ]
}

# --- 3. Bot Fight Mode (free) — NOT applied via API (token lacks the scope,
#        and the free-plan toggle isn't cleanly API-exposed). Enable by hand:
#        dash > zone > Security > Bots > Bot Fight Mode > On.

# --- 4. Turnstile widget for the signup form — NOT yet created.
#        The API token CAN create it (Account > Turnstile). Deferred until the
#        hardening/turnstile branch is deployable (needs the Firebase deploy SA
#        to have secretmanager.secrets.setIamPolicy). See the runbook.
resource "cloudflare_turnstile_widget" "signup" {
  account_id = var.cloudflare_account_id
  name       = "anytime signup"
  domains    = var.turnstile_domains
  mode       = "managed"
}

output "turnstile_site_key" {
  value       = cloudflare_turnstile_widget.signup.id
  description = "Public — put in .env.production as VITE_TURNSTILE_SITE_KEY"
}

output "turnstile_secret" {
  value       = cloudflare_turnstile_widget.signup.secret
  sensitive   = true
  description = "firebase functions:secrets:set TURNSTILE_SECRET"
}
