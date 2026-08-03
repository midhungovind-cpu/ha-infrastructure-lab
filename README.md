# HA Infrastructure Lab

A browser-based high-availability training simulator. It models a two–data-centre Linux estate — HAProxy/keepalived at the edge, Pacemaker + Corosync + DRBD under the database and storage tiers, GTID replication out to a read tier, KVM/libvirt underneath — and lets you break it and fix it from an allowlisted Linux-style terminal.

**[▶ Live demo](https://midhungovind-cpu.github.io/ha-infrastructure-lab/)** · **[Architecture reference](ARCHITECTURE.md)**

Everything runs locally in the browser. There are no external connections, nothing is executed on the host, and all hostnames, addresses, credentials and configuration files are fictional.

![Simulated MariaDB failover, verified with Pacemaker status](docs/failover-demo.gif)

---

## Why this exists

Most HA knowledge is only provable in front of a rack. This is an attempt to make the *reasoning* provable instead: a deterministic model of a production-shaped estate, seventeen focused exercises drawn from real incident classes, and a success criterion for each one that a service restart alone cannot satisfy.

The recurring theme across the drills is deliberate — **the process is running and the system is still broken.** A stale PID file, a stopped SQL thread, a Disconnected DRBD peer, an Elasticsearch cluster with allocation disabled: in every case `systemctl status` is green and the platform is not healthy.

## Quick start

```bash
git clone https://github.com/midhungovind-cpu/ha-infrastructure-lab.git
cd ha-infrastructure-lab
npm start          # serves on http://localhost:4173
```

Or open `index.html` directly in a modern browser — there is no build step.

```bash
npm test           # engine unit tests
```

## A first run

```
ssh root@mysql-core01
systemctl stop mariadb          # kill the write path
pcs status                      # watch the group relocate
ip a | grep 10.10.20.10         # confirm who owns the VIP now
drbdadm status                  # confirm the data followed
mysql -e "SHOW SLAVE STATUS\G"  # confirm the replica re-attached
```

State persists across reconnects and page reloads. The **Exercises** tab injects and resets scenarios; **Snapshots** preserves a point in time so you can retry a drill from the same starting state.

## What is modelled

| Tier | Nodes | Mechanism |
| --- | --- | --- |
| Edge | haproxy01/02 | HAProxy L7 + keepalived VRRP, VIP 10.10.10.10 |
| Cache | varnish01/02 | Varnish with health probes and grace mode |
| Web | web01–03 | `web01/02`: Nginx + PHP-FPM; `web03`: Lighttpd + PHP-FPM |
| Database | mysql-core01/02, mysql-slave01 | Pacemaker + DRBD protocol C, VIP 10.10.20.10, GTID replication |
| Storage | san01/02 | DRBD + NFSv4 under Pacemaker, VIP 10.10.30.10 |
| Transfer | ftp01/02 | Pure-FTPd, TLS required, passive range |
| Queue &amp; data | rabbitmq01–03, cassandra01–03, elasticsearch01–03 | Quorum queues, NTS ring, 3 master-eligible nodes |
| Virtualisation | kvm01/02 | libvirt, bridged networking, LVM-backed guests |
| Recovery site | `dr-` mirror of the above on 10.20.0.0/16 | Warm; promoted by declaration, never automatically |

The modelled topology, ownership rules, recovery flow and exercise coverage are in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

![Conceptual HA reference architecture](docs/architecture.png)

## The drills

Seventeen focused exercises across twelve incident categories, each with a symptom, a triage sequence, a root cause and a success criterion. Solutions stay hidden until requested.

1. HAProxy will not start after a crash — stale PID file
2. Config change broke the proxy — invalid directive survives a reload
3. MariaDB crashed; cluster failed over — failed action needs cleanup
4. Replica stopped — duplicate key 1062
5. DRBD peers Disconnected — port 7789 dropped by firewalld
6. DRBD split brain — Primary/Primary
7. Database VIP moved with a failed action — clean up the cluster history
8. SAN filesystem at 98 % — core file, and the inode check people skip
9. Active SAN node offline — recover without a second interruption
10. Secure FTP failing — expired certificate *and* a missing passive range
11. Guests lost backend connectivity — bridge slave on the wrong master
12. RabbitMQ cookie mismatch
13. Cassandra node marked DOWN
14. Elasticsearch allocation disabled
15. Primary site unreachable — declare recovery readiness
16. Recovery-site promotion required
17. Primary site ready for controlled return

## Project layout

```
src/state.js       deterministic initial topology and the persisted state store
src/engine.js      allowlisted command parser, virtual filesystem, HA event engine
src/scenarios.js   scenario definitions, root causes, health predicates
src/app.js         terminal tabs, dashboard, scenario UI, rendering
lab-images/        illustrative fictional seed configuration files
tests/             engine unit tests (node --test)
```

The engine favours consistent operational behaviour over emulating every shell feature. Unsupported commands return a CentOS-style message rather than pretending to work.

## Disclaimer

All hostnames, IP addresses, credentials and configuration in this repository are fictional and exist only to model a topology. Addresses use RFC 1918 and RFC 5737 documentation ranges. Nothing here is taken from any employer or client environment.

## License

MIT — see [LICENSE](LICENSE).
