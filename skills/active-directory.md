# Active Directory

- Triage order: DNS -> DC health -> replication -> time sync -> Kerberos/SPN -> GPO.
- Commands: `dcdiag /v`, `repadmin /replsummary`, `repadmin /showrepl`, `nltest /dsgetdc:<domain>`, `w32tm /query /status`, `setspn -Q`, `gpresult /h`.
- Account issues: lockout source (event 4740 on PDC), password expiry, disabled/expired accounts.
- Hand off: server OS/service problems -> @zu; SQL logins and database access -> @charles.
