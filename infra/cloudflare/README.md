# Cloudflare zone hardening (Terraform)

Protects the Pages app + `/api/*` only. Firestore / Cloud Functions / Auth are
protected by Firebase App Check, not here (their traffic never touches this zone).

Full context: `docs/superpowers/specs/2026-09-07-abuse-dos-hardening-design.md` §E.

## Apply

1. Create an API token: dash → My Profile → API Tokens → Create Token → Custom.
   Permissions:
   - **Zone → WAF → Edit**
   - **Zone → Rate Limiting → Edit** (some accounts: under "Zone → Zone WAF")
   - **Zone → Zone Settings → Edit**
   - **Account → Turnstile → Edit**
   Zone resources: the `anytime.rokafa.app` zone. Account resources: your account.
2. `cp terraform.tfvars.example terraform.tfvars` and fill in.
   - `cloudflare_zone_id`, `cloudflare_account_id`: zone Overview page, right sidebar.
3. `terraform init`
4. `terraform plan` — **this is the gate.** The provider's `rules = [{...}]`
   object shape can drift between v5 patch releases. If plan errors on a field,
   open the resolved provider version's docs for `cloudflare_ruleset` /
   `cloudflare_zone_setting` / `cloudflare_turnstile_widget` and adjust, or use
   the by-hand steps below (version-independent).
5. `terraform apply`
6. `terraform output turnstile_site_key` → paste into `.env.production` as
   `VITE_TURNSTILE_SITE_KEY`, commit (Pages rebuilds).
   `terraform output -raw turnstile_secret` →
   `firebase functions:secrets:set TURNSTILE_SECRET` (paste when prompted).

## Verify in the dashboard

- Security → WAF → Rate limiting rules: 1 rule, "Block", `/api/*` POST, 20 per 60s.
- Security → WAF → Custom rules: 4 rules, enabled.
- Security → Bots: Bot Fight Mode = On.
- Turnstile: one "anytime signup" widget, Managed, 3 domains.

## By hand (if Terraform is blocked)

Same rules, in the dashboard:

**Rate limiting rule** (Security → WAF → Rate limiting rules → Create):
- Expression: `(starts_with(http.request.uri.path, "/api/") and http.request.method eq "POST")`
- When rate exceeds: 20 requests per 60 seconds; characteristics: IP + Colo
- Action: Block, duration 60 seconds

**Custom rules** (Security → WAF → Custom rules → Create), in order:
1. `(starts_with(http.request.uri.path, "/api/") and http.request.method eq "POST" and not any(http.request.headers.names[*] == "authorization") and not http.request.uri.path in {"/api/board-sweep" "/api/push-fanout"})` → Block
2. `(not http.request.method in {"GET" "POST" "HEAD" "OPTIONS"})` → Block
3. `(starts_with(http.request.uri.path, "/api/") and cf.threat_score gt 20)` → Managed Challenge
4. `(starts_with(http.request.uri.path, "/api/") and ip.geoip.country ne "KR")` → Managed Challenge

**Bot Fight Mode**: Security → Bots → toggle on.

**Turnstile**: Turnstile → Add widget → name "anytime signup", Managed, domains
`anytime.rokafa.app`, `anytime-dzi.pages.dev`, `localhost`.

## State

Local state only (`.gitignore`d). No remote backend — this config changes rarely
and is a single operator's responsibility.
