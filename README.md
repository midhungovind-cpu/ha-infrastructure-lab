# HA Infrastructure Lab

Interactive, browser-based High Availability incident-response simulator with persistent virtual Linux nodes.

It models fictional CentOS 8-like nodes, clusters, replication, storage incidents, and an allowlisted Linux-style terminal. It has no external connections and never executes entered commands on the host.

![Conceptual HA reference architecture](docs/architecture.png)

## What this demonstrates

- Pacemaker-style resource management and floating VIP failover
- MySQL replication and DRBD recovery workflows
- Stateful simulated SSH sessions and editable virtual server files
- Guided incident exercises that require diagnosis, repair, and validation
- Browser-local snapshots, resettable lab state, and no real infrastructure access

## Run

```bash
npm start
```

Then open `http://localhost:4173`. Or open `index.html` directly in a modern browser.

## Test

```bash
npm test
```

## Demonstration

1. Open Terminal and run `ssh root@mysql-core01` then `systemctl stop mariadb`.
2. Run `pcs status` and `ip a` to observe database recovery and VIP ownership.
3. Run `mysql`, then `STOP SLAVE;`, `EXIT;`, and inspect `mysql -e "SHOW SLAVE STATUS\\G"`.
4. Start replication with `mysql -e "START SLAVE;"`; state survives reconnects and page reloads.
5. Use the **Exercises** page to inject and reset failures, and **Snapshots** to preserve a point in time.

## Safety

This is a fictional, browser-only training simulator. It never connects to, reads from, writes to, or runs commands on real infrastructure. All IP addresses, server names, service data, and incident evidence are simulated.

## Architecture

- `src/state.js`: deterministic initial topology and persisted state store.
- `src/engine.js`: allowlisted terminal parser, virtual filesystem and HA event engine.
- `src/app.js`: terminal tabs, dashboard, scenario UI, and rendering.
- `lab-images/`: illustrative fictional seed files. Runtime edits are stored only in browser local storage.

The implementation intentionally favors consistent operational behavior over emulating every shell feature. Unsupported commands return a CentOS-style message.
