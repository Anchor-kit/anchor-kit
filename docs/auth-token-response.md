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
