# SEP-10 auth token response

POST /auth/token requires a wallet-signed SEP-10 challenge and an
application/json request body. A successful response has these fields:

| Field      | Meaning                                   |
| ---------- | ----------------------------------------- |
| token      | Bearer access token.                      |
| token_type | Always Bearer.                            |
| expires_in | Token lifetime in seconds.                |
| expires_at | Absolute expiry as an ISO 8601 timestamp. |

The expires_in value is the duration for refresh scheduling. The expires_at
value is useful for displaying or checking the absolute expiry time. Challenge
and token responses use Cache-Control: no-store and must not be cached.

## Access token claims

The `token` is a JWT signed with HS256 using `security.interactiveJwtSecret`.
It carries a stable issuer, audience, and scope so a token minted for an
unintended service cannot be replayed against the anchor API even when the
shared secret is the same:

| Claim | Value           | Meaning                                          |
| ----- | --------------- | ------------------------------------------------ |
| sub   | Stellar account | The authenticated account.                       |
| iss   | `anchor-kit`    | Stable token issuer.                             |
| aud   | `anchor-api`    | Stable audience bound to the anchor API.         |
| scope | `anchor_api`    | Access scope required by the SDK route handlers. |
| typ   | `access_token`  | Token type expected by bearer authentication.    |

Bearer authentication requires `iss` to equal `anchor-kit` and `aud` to equal
`anchor-api`. Tokens with a missing or mismatched `iss` or `aud` are rejected
with HTTP 401 and the `unauthorized` error code.

Example response:

```json
{
  "token": "fictional-token-value",
  "account": "GABC1234567890FICTIONALACCOUNT000000000000000000000000000",
  "expires_in": 3600,
  "expires_at": "2026-08-30T12:00:00.000Z",
  "token_type": "Bearer"
}
```

## Rotating the signing secret

The signing key is configured as `security.interactiveJwtSecret` (the example
application reads it from `INTERACTIVE_JWT_SECRET`). Bearer verification uses
the currently configured value to verify the JWT signature. Tokens signed with
the previous value therefore fail verification after the new value is loaded;
active clients must obtain a new token through the SEP-10 challenge flow.

To rotate the key:

1. Generate a new high-entropy secret using your organization's approved secret
   manager or key-generation process.
2. Update the deployment's `INTERACTIVE_JWT_SECRET` secret value and deploy the
   configuration change. Do not put the value in source control, command
   arguments, tickets, or logs.
3. Tell users and operators that existing interactive sessions will require
   reauthentication after the rotation.
4. Confirm that a newly issued token authenticates successfully and that a
   token issued before rotation is rejected. Never print either token or secret
   while checking logs.

Use a placeholder such as `<new-secret>` in runbooks and examples. This
configuration supports one active signing key, so rotation interrupts existing
sessions; schedule the change accordingly.
