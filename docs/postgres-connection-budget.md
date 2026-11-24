# PostgreSQL connection budget

The SQL database adapter creates one `pg.Client` and opens it when the adapter
connects. It does not configure a connection pool. Each adapter instance keeps
that client until it closes. Budget one connection for every live adapter
instance across API and worker processes.

## Calculate the application maximum

Use this formula:

`connections = API replicas × API processes per replica × API adapters per process + worker replicas × worker processes per replica × worker adapters per process`

Count every service that uses the same PostgreSQL database. Include deployment
surge capacity when rolling updates can run old and new replicas at once.

For example, suppose a fictional database allows 100 connections. An
application runs 3 API replicas and 2 worker replicas, with one process and one
adapter in each. It can use up to `(3 × 1 × 1) + (2 × 1 × 1) = 5` connections.
If a rolling deployment temporarily doubles each service, the application may
use 10. Multiple processes or adapters per process multiply the count.

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
