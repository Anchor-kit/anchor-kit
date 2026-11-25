# PostgreSQL connection budget

The SQL database adapter opens one long-lived `pg.Client` per adapter instance.
It does not configure a connection pool. `createDepositWithIdempotency` also
opens a short-lived client for each concurrent PostgreSQL deposit transaction.
Budget for both the live adapter clients and the peak number of overlapping
deposit transactions across API and worker processes.

## Calculate the application maximum

Use this formula:

`connections = live adapter clients + peak concurrent PostgreSQL deposit transactions`

Calculate live adapter clients as:

`API replicas × API processes per replica × API adapters per process + worker replicas × worker processes per replica × worker adapters per process`

Count every service that uses the same PostgreSQL database. Include deployment
surge capacity when rolling updates can run old and new replicas at once.

For example, an application runs 3 API replicas and 2 worker replicas, with one
process and one adapter in each. Those adapters use 5 long-lived connections.
If up to 4 PostgreSQL deposit transactions can overlap, budget 9 application
connections. A rolling deployment that doubles the replicas and the expected
transaction concurrency can raise that peak to 18. Multiple processes or
adapters per process multiply the long-lived client count.

Reserve connections for migrations, administration, monitoring, other
applications, and failover or deployment overlap. For example, if the database
limit is 100, operators reserve 20 for those needs, and the application has a
planned maximum of 10, the budget remains within the 80 connections available
to this application. Treat these as planning values: confirm actual process and
adapter counts in the deployment configuration, and verify live connection
usage at the database before raising replica counts.

If the application needs a pool, configure and budget that pool explicitly;
the current adapter's single-client behavior should not be mistaken for a
pool-size setting.
