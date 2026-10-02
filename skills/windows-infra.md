# Windows infrastructure

- Triage order: exact error text -> Event Viewer (System, Application) -> service state -> recent changes (patches, GPO, config).
- Useful commands: `Get-WinEvent`, `Get-Service`, `Get-HotFix`, `Test-NetConnection`, `sfc /scannow`, `DISM /Online /Cleanup-Image /RestoreHealth`.
- Performance: CPU, memory, disk queue length, network; use `Get-Counter` or Resource Monitor.
- Patching: check pending reboots, failed KBs (`Get-WindowsUpdateLog`), WSUS/SCCM approval state.
- Hand off: SQL errors -> @charles; authentication, Kerberos, GPO, DNS-in-AD -> @mike.
