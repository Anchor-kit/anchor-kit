# Customer identity storage

The SQL adapter stores customer identity data in `customers` and associates Stellar account IDs
through `customer_accounts`. `insertOrGetCustomer()` is idempotent for a repeated customer ID and
account association; it returns the stored record rather than creating a duplicate. An account
can be linked to only one customer. Reusing an account for a different customer fails explicitly.

Use `getCustomerByAccountId()` to read the customer associated with an authenticated account. The
lookup is scoped to the exact account ID; there is no unscoped customer lookup in the adapter API.
The customer tables are created by the existing `migrate()` operation, so records survive
disconnect and reconnect.

## SEP-12 customer checks

The router exposes authenticated `GET /customer` and `PUT /customer` routes for deposit
transactions. Both requests require `transaction_id` and `type`; the transaction must belong to the
account in the bearer token. The transaction's asset code selects the required fields configured
through `kycRequired`.

`PUT /customer` accepts JSON or URL-encoded scalar fields. It stores supported SEP-9 fields and
configured custom fields, then sends complete submissions to the optional
`kycVerificationProvider` passed to `createAnchor`. Without a provider, complete submissions stay
in `PROCESSING`. The response reports missing fields and field status without returning submitted
identity values. Binary document uploads are not supported by these minimal routes.
If upstream middleware parses the request first, it must retain the original bytes as `rawBody`;
parsed-only bodies are rejected because their original size and duplicate fields cannot be checked.

`GET /customer` returns the current status and any missing required fields for the authenticated
customer. A customer ID from another account returns `404`; a transaction owned by another account
returns `403`.

Focused verification:

```bash
bun test tests/runtime/database/sql-database-adapter.test.ts
bun test tests/runtime/sep12-customer-endpoints.test.ts
```

Expected result: the adapter tests pass, including account isolation, creation replay, and
reconnect persistence. The endpoint tests cover missing fields, provider status, PII redaction,
malformed submissions, and cross-account access.
