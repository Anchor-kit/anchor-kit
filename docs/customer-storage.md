# Customer identity storage

The SQL adapter stores customer identity data in `customers` and associates Stellar account IDs
through `customer_accounts`. `insertOrGetCustomer()` is idempotent for a repeated customer ID and
account association; it returns the stored record rather than creating a duplicate. An account
can be linked to only one customer. Reusing an account for a different customer fails explicitly.

Use `getCustomerByAccountId()` to read the customer associated with an authenticated account. The
lookup is scoped to the exact account ID; there is no unscoped customer lookup in the adapter API.
The customer tables are created by the existing `migrate()` operation, so records survive
disconnect and reconnect.

Focused verification:

```bash
bun test tests/runtime/database/sql-database-adapter.test.ts
```

Expected result: the adapter tests pass, including account isolation, creation replay, and
reconnect persistence.
