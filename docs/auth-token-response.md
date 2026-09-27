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
