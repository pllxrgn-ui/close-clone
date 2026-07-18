# Real SSO with zero accounts — the Keycloak profile

Switchboard authenticates via OIDC against your company IdP. To prove the
real-mode path (`MOCK_MODE=0`) end to end **without any external account**, the
deploy stack ships a self-hosted [Keycloak](https://www.keycloak.org/) issuer
behind the `keycloak` compose profile. It is OFF by default and does not affect
the normal stack.

## Start it

```bash
cd deploy
docker compose --env-file .env -f docker-compose.yml --profile keycloak up -d keycloak
# wait ~40s for the realm import, then:
curl -s http://localhost:8081/realms/switchboard/.well-known/openid-configuration | jq .issuer
#   → "http://localhost:8081/realms/switchboard"
```

The realm (`keycloak/switchboard-realm.json`) is imported on boot: an OIDC
confidential client `switchboard`, the two groups the app maps to roles, a
protocol mapper that emits `groups` **as names** into the ID token (what
`apps/api/src/auth/rbac.ts` requires), and three test users:

| Username   | Password   | Groups                             | Role in Switchboard     |
| ---------- | ---------- | ---------------------------------- | ----------------------- |
| `ada`      | `ada`      | sales-crm-users + sales-crm-admins | **admin**               |
| `rep`      | `rep`      | sales-crm-users                    | rep                     |
| `nomember` | `nomember` | (none)                             | **refused** (no access) |

`nomember` is the §8 "a non-group user is refused" check: a valid IdP login that
Switchboard rejects because no group grants access.

## Point the API at it

Add to `deploy/.env` (these are the exact values the composition root reads):

```dotenv
MOCK_MODE=0
OIDC_ISSUER=http://localhost:8081/realms/switchboard
OIDC_CLIENT_ID=switchboard
OIDC_CLIENT_SECRET=switchboard-dev-secret
WEB_ORIGIN=http://localhost:8080
```

`OIDC_ISSUER` must match the discovery `issuer` **exactly** — the ID-token check
is an exact string compare (`auth/oidc/id-token.ts` → `issuer_mismatch`). That is
why the Keycloak service pins `KC_HOSTNAME=http://localhost:8081`: the issuer is
identical whether the browser or the api resolves it.

Then bring the api up in real mode (`docker compose … up -d api`) and sign in at
the web front door — it renders the SSO screen in real mode and hands off to
`/api/v1/auth/login`.

> **Direct-grant proof (no browser):** the client has direct access grants
> enabled, so you can prove the groups claim from a shell:
>
> ```bash
> curl -s -X POST http://localhost:8081/realms/switchboard/protocol/openid-connect/token \
>   -d grant_type=password -d client_id=switchboard \
>   -d client_secret=switchboard-dev-secret -d username=ada -d password=ada -d scope=openid \
>   | jq -r .id_token | cut -d. -f2 | base64 -d 2>/dev/null | jq '.groups'
> #   → ["sales-crm-users","sales-crm-admins"]
> ```

## Swap for your real company IdP

Nothing in the app changes. Stop the Keycloak profile, and set `OIDC_ISSUER` /
`OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` in `.env` to the values your IT/admin
gives you (Okta, Entra, Auth0, …). The only requirements on their side are the
two groups `sales-crm-users` / `sales-crm-admins` in a **`groups` claim carrying
names** (Entra emits GUIDs by default — ask for names, or file it as a mapping
task). Google Workspace does not emit group membership in its ID token and needs
extra Directory-API work; prefer any other OIDC IdP.
