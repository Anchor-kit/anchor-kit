# Customer data export procedure

This procedure exports one customer's record and linked Stellar account IDs from the SQL schema
used by `SqlDatabaseAdapter`. Run it only for an approved support, privacy, or legal request. Use
an authorized, read-only database identity and record the request ID, approver, operator, and time
in the organization's access log. Do not place credentials or customer values in shell history,
terminal recordings, tickets, or this guide.

## Export one customer

Use the immutable customer ID from the approved request. Do not select by email, phone number, or
an account ID supplied without verification. The schema stores customer fields in `customers`
and account associations in `customer_accounts`.

For PostgreSQL, run the following in a read-only transaction, replacing the parameter with the
approved customer ID through the database client's parameter binding:

```sql
BEGIN TRANSACTION READ ONLY;

SELECT c.id, c.email_address, c.phone_number, c.kyc_data, c.created_at,
       ca.account_id, ca.created_at AS account_linked_at
FROM customers AS c
LEFT JOIN customer_accounts AS ca ON ca.customer_id = c.id
WHERE c.id = $1
ORDER BY ca.account_id;

COMMIT;
```

Do not interpolate request values into SQL. If using SQLite, use `BEGIN` and `?` as the parameter
placeholder. Keep the database connection read-only where the SQLite client supports it.

## Verify the scope

Before saving the result, verify that every row has the requested `customers.id` and that each
non-null account ID belongs to that customer's `customer_accounts` records. Multiple rows are
expected when a customer has multiple linked accounts; they share one distinct `customers.id`.
A customer with no linked account produces one row with a null account ID because the query uses
a left join. Stop and escalate if another customer ID appears, an account is not linked to the
requested customer, or the result conflicts with the approved request.

Use fictional values for any review or example. For instance, `customer_demo_17` with
`GABC...DEMO` is illustrative only; it is not a real customer or account.

## Protect and dispose of the export

- Save the export only to the organization's approved encrypted, access-controlled transfer
  location. Limit access to the authorized recipient and operator.
- Encrypt the file using the approved transfer mechanism. Send any separately managed password
  or key through the organization's approved separate channel.
- Confirm the recipient and transfer completion without copying exported fields into messages.
- Remove temporary local copies and intermediate files after delivery. Follow the organization's
  retention and secure-deletion policy; do not promise that ordinary file deletion securely
  erases SSD, snapshot, or backup copies.
- Record the export scope, recipient, transfer time, and disposal action in the access log without
  recording the exported values themselves.

The export may contain contact details and KYC data. Handle it under the organization's privacy,
retention, and incident-response requirements. This guide does not grant access or define a legal
basis for a particular request.
