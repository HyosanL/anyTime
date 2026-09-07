# Cloudflare zone hardening

Protects the Pages app + `/api/*` only. Firestore / Cloud Functions / Auth are
protected by Firebase App Check, not here (their traffic never touches this zone).

Full context: `docs/superpowers/specs/2026-09-07-abuse-dos-hardening-design.md` §E.

## Status — APPLIED 2026-09-07 (via Cloudflare API, not Terraform)

Live on zone `b4c035a5f9ac9b941be9b9c89455a020`:

**Rate limiting** (`http_ratelimit` entrypoint, ruleset `e81b8ae547024de080a758ea8dae01fe`)
- block IPs exceeding **10 POST `/api/*` per 10s** (free plan locks period + timeout to 10s)

**WAF custom rules** (`http_request_firewall_custom` entrypoint, ruleset `cea4307af84943018ba1c2c490ffc7ba`)
1. block `/api/*` POST with no `Authorization` header — `/api/board-sweep` and `/api/push-fanout` excluded (secret-gated)
2. block non-`GET/POST/HEAD/OPTIONS` methods
3. managed challenge for `cf.threat_score > 50` on top-level page loads (not `/api/*`, not assets) — so the earned `cf_clearance` cookie propagates to later fetches

Verified live: authenticated POST → passes (middleware 401 on bad token); no-auth
POST → 403; `GET /`, `/assets/*` → 200; `/api/board-sweep` → 401 (middleware).

## Still to do by hand (dashboard)

- **Bot Fight Mode**: Security → Bots → Bot Fight Mode → **On**. (Token lacks the
  scope; the free toggle isn't cleanly API-exposed.)
- **Turnstile widget**: deferred — the `hardening/turnstile` branch can't deploy
  until the Firebase deploy service account gets `secretmanager.secrets.setIamPolicy`
  (or Secret Manager Admin). Once it can: `main.tf`'s `cloudflare_turnstile_widget`
  resource, or dash → Turnstile → Add widget ("anytime signup", Managed, domains
  `anytime.rokafa.app` / `anytime-dzi.pages.dev` / `localhost`).

## Re-applying / editing the rules

Same API, PUT the entrypoint ruleset (replaces all rules in that phase):

```
curl -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets/phases/http_request_firewall_custom/entrypoint" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data @waf.json
```

`waf.json` / `rl.json` request bodies: the `rules` arrays are transcribed in
`main.tf`. Read them back with `GET .../entrypoint`.

## Adopting Terraform later

The token needs **Zone → WAF → Edit** (covers both custom rules and rate limiting
rules — there is no separate "Rate Limiting" permission on current Cloudflare).
Import the existing rulesets before the first `apply` (IDs in `main.tf`), else
Terraform creates duplicates.
