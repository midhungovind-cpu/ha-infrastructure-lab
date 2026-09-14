# Simulator verification — 14 September 2026

Build: **2026.09.14.22** (broader UI, command and persistence audit).

## Checks performed

- `npm test`: **104 passing tests**, including individually reported recovery paths for all 17 exercises and hint/explanation content checks.
- Every exercise starts incomplete and has a working repair or explicit operator-action path.
- Exercise completion survives state serialization.
- Browser walkthrough: **17 of 17 resolved** using terminal commands and the Check resolution buttons; progress survives reload.
- No browser console errors observed during this walkthrough.
- Browser negative check: Elasticsearch allocation `none` stays unresolved; `all` resolves the incident.
- Guidance follow-up: both hint and explanation dialogs opened for all 17 exercises; Close and Escape dismissed them. An unresolved exercise remained incomplete after viewing both. No console errors observed.

Additional audit coverage:

- 1,674 missing/invalid command-input cases across six host types, with no uncaught exceptions.
- All 54 node addresses checked for uniqueness; recovery addressing and legacy-state migration tested.
- Browser controls: snapshot save, cancel, named restore, clean restore and reload; reset cancel/confirm; VM shutdown cancel/confirm, start and reboot; editor save/Escape cancel; terminal tabs, tab completion and Ctrl+C.
- Read-only `sed`, file self-moves, recursive removal, `find`, service enable/disable, valid FTP restart, reverse failover and wrong-host repair rejection.
- Unknown hosts and stopped services cannot pass HTTP/ping checks; distributed membership and Elasticsearch are checked independently per site.
- Browser-storage failure is handled without losing the in-memory session; virtual file deletions survive reload.
- Local-server GET/HEAD, unsupported methods, missing/malformed paths, hidden files and outside-root symlinks tested.

## Corrections covered

- New exercise evidence is scoped to relevant hosts and excludes pre-injection history.
- Site declaration, promotion and controlled return require explicit simulator-only commands.
- Site promotion checks primary isolation, recovery service availability and replication state.
- Split-brain recovery retains the chosen victim and aligns the surviving writer, DRBD roles and service ownership.
- VM list IDs agree with console and domain lookup after a guest shutdown.
- Unsupported pipeline stages and shell chaining are rejected before partial execution; quoted sudo patterns and zero-line tail work.
- MySQL duplicate-key injection stops only the SQL thread; SAN logs identify the root filesystem consistently with disk output.
- Elasticsearch allocation updates parse the requested JSON value instead of matching the word allocation.

## Boundaries

These checks validate supported simulator workflows, not a production Linux environment or every possible command sequence. DNS, replication synchronization and site transitions remain abstractions. `labctl` is a fictional training control, not a real operational command or proof that a production site is safe to promote. Some general networking and system commands still provide simplified output.

Older saved site incidents should be restarted to use the new operator-action flow. Existing unrelated exercise completion is retained.
