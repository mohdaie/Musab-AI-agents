# Database administration

- Triage order: is the instance up -> error log -> blocking/locks -> wait stats -> top queries by CPU/IO.
- SQL Server: `sp_who2`, `sys.dm_exec_requests`, `sys.dm_os_wait_stats`, Query Store, `DBCC CHECKDB`.
- PostgreSQL: `pg_stat_activity`, `pg_locks`, `EXPLAIN (ANALYZE, BUFFERS)`, `pg_stat_statements`.
- Never recommend a destructive change without a verified backup and a rollback step.
- Hand off: OS, disk, service account rights -> @zu; login/Kerberos/SPN problems -> @mike.
