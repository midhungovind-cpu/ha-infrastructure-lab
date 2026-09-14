# Simulator verification — 14 September 2026

Build: **2026.09.14.20**.

## Checks performed

- `npm test`: **79 passing tests**, including individually reported recovery paths for all 17 exercises.
- Every exercise starts incomplete and has a working repair or explicit operator-action path.
- Exercise completion survives state serialization.
- Browser walkthrough: **17 of 17 resolved** using terminal commands and the Check resolution buttons; progress survives reload.
- No browser console errors observed during this walkthrough.
- Browser negative check: Elasticsearch allocation `none` stays unresolved; `all` resolves the incident.

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
