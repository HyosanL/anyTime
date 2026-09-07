# =============================================================================
#  Cloudflare zone hardening for anytime.rokafa.app  (Pages app + /api/*)
#  Firestore / Cloud Functions / Auth traffic does NOT pass through this zone —
#  it is defended by Firebase App Check, not here.
#
#  Free plan limits (verified 2026-09): 1 rate-limiting rule (block only,
#  period 10/60s, duration 60s/1h), 5 WAF custom rules (all actions but Log).
#
#  `terraform plan` is the syntax gate — the cloudflare provider's `rules`
#  object shape shifts between patch releases. If plan errors on a rule field,
#  cross-check the resource docs for your resolved provider version, or fall
#  back to the dashboard steps in README.md (same expressions and thresholds).
# =============================================================================

# --- 1. Rate limiting: the single free-plan rule, on write-ish /api POSTs ---
resource "cloudflare_ruleset" "ratelimit" {
  zone_id     = var.cloudflare_zone_id
  name        = "anytime rate limiting"
  description = "Free-plan single rule: cap /api/* POST per IP"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [{
    ref         = "api_post_per_ip"
    description = "Block IPs doing >20 POST /api/* per minute for 1 minute"
    expression  = "(starts_with(http.request.uri.path, \"/api/\") and http.request.method eq \"POST\")"
    action      = "block"
    ratelimit = {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = 20
      mitigation_timeout  = 60
    }
  }]
}

# --- 2. WAF custom rules (<=5 on free) ---
resource "cloudflare_ruleset" "custom_fw" {
  zone_id     = var.cloudflare_zone_id
  name        = "anytime custom firewall"
  description = "Abuse-surface hardening for /api/*"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      ref         = "api_requires_auth"
      description = "Block /api/* POST with no Authorization header (except the secret-gated webhooks)"
      expression  = "(starts_with(http.request.uri.path, \"/api/\") and http.request.method eq \"POST\" and not any(http.request.headers.names[*] == \"authorization\") and not http.request.uri.path in {\"/api/board-sweep\" \"/api/push-fanout\"})"
      action      = "block"
    },
    {
      ref         = "block_weird_methods"
      description = "Only GET/POST/HEAD/OPTIONS"
      expression  = "(not http.request.method in {\"GET\" \"POST\" \"HEAD\" \"OPTIONS\"})"
      action      = "block"
    },
    {
      ref         = "challenge_high_threat"
      description = "Managed challenge for high threat score on /api/*"
      expression  = "(starts_with(http.request.uri.path, \"/api/\") and cf.threat_score gt 20)"
      action      = "managed_challenge"
    },
    {
      ref         = "challenge_non_kr_api"
      description = "Managed challenge for non-KR traffic to /api/* (overseas cadets / VPN pass the challenge)"
      expression  = "(starts_with(http.request.uri.path, \"/api/\") and ip.geoip.country ne \"KR\")"
      action      = "managed_challenge"
    },
  ]
}

# --- 3. Bot Fight Mode (free) ---
# The single-setting resource name has changed across provider versions
# (cloudflare_zone_setting). If `terraform plan` rejects this block, enable
# "Bot Fight Mode" by hand: dash > zone > Security > Bots. See README.
resource "cloudflare_zone_setting" "bot_fight_mode" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "bot_fight_mode"
  value      = "on"
}

# --- 4. Turnstile widget for the signup form ---
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
