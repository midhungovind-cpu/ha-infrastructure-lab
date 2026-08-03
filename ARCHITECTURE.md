# HA Infrastructure Lab - architecture reference

This is the public, concise reference for the browser simulator in this repository. It is a fictional training model, not a deployment guide or a record of an employer environment.

**[Open the live simulator](https://midhungovind-cpu.github.io/ha-infrastructure-lab/)** · **[Read the project overview](README.md)**

Everything runs in the browser. The terminal is an allowlisted simulator: it never connects to a host, executes commands on the user's machine, or exposes real infrastructure.

## What the model is designed to teach

- Work from symptoms and service health, rather than assuming a running process means a healthy platform.
- Keep database and storage ownership tied to the data layer during a failure.
- Distinguish automatic **intra-site** failover from a deliberate **cross-site** recovery decision.
- Verify recovery through client-facing state: VIP ownership, replication, DRBD role, health and application reachability.

## Topology

```text
                             Primary site: 10.10.0.0/16

  user -> DNS -> edge VIP -> HAProxy -> Varnish -> web tier
                    |                                |
                    |                         database VIP
                    |                                |
                    |           +--------------------+-------------------+
                    |           |                    |                   |
                    v           v                    v                   v
                keepalived   MariaDB / DRBD       NFS / DRBD      distributed services
                             Pacemaker cluster    Pacemaker cluster  RabbitMQ, Cassandra,
                                                                      Elasticsearch

  bastion01 is the simulated access point. kvm01 and kvm02 host selected
  simulated guests. mon01 represents monitoring and logs.

                             Recovery site: 10.20.0.0/16
  A warm, `dr-` prefixed mirror exists for the modelled service tiers.
  It becomes authoritative only through a simulated, manual declaration.
```

## Modelled tiers

| Tier | Modelled nodes | Availability behaviour |
| --- | --- | --- |
| DNS and edge | `dns01`, `haproxy01/02` | HAProxy and keepalived own the edge request path and the `10.10.10.10` VIP. |
| Cache and web | `varnish01/02`, `web01/02/03` | Varnish cache; `web01/02` use Nginx/PHP-FPM and `web03` uses Lighttpd/PHP-FPM. |
| Database | `mysql-core01/02`, `mysql-slave01` | Pacemaker + Corosync coordinate a DRBD-backed MariaDB writer; the replica uses GTID state. |
| Storage | `san01/02` | Pacemaker coordinates DRBD and the NFS export. |
| File transfer | `ftp01/02` | Pure-FTPd with TLS and a passive port range. |
| Distributed services | `rabbitmq01-03`, `cassandra01-03`, `elasticsearch01-03` | Cluster membership, node health and allocation state are represented. |
| Platform | `kvm01/02`, `mon01`, `bastion01` | libvirt-style VM controls, bridge state, monitoring/log fixtures and lab access. |
| Recovery | `dr-` service nodes | A warm simulated recovery site, promoted only by an explicit exercise flow. |

`web03` is modelled as Lighttpd with PHP-FPM. It is not an Apache/cPanel host.

## Network and service ownership

| Service | Address | Mechanism | Default owner |
| --- | --- | --- | --- |
| Edge ingress | `10.10.10.10` | keepalived / HAProxy | `haproxy01` |
| Database writes | `10.10.20.10` | Pacemaker + DRBD | `mysql-core01` |
| NFS export | `10.10.30.10` | Pacemaker + DRBD | `san01` |

The model uses private `10.10.0.0/16` and `10.20.0.0/16` address spaces. The primary site uses service ranges for edge (`10.10.10.0/24`), web (`10.10.12.0/24`), database (`10.10.20.0/24`), storage (`10.10.30.0/24`), virtualisation (`10.10.40.0/24`), DNS (`10.10.50.0/24`), queue/data (`10.10.60.0/24` through `10.10.62.0/24`) and monitoring (`10.10.70.0/24`).

## Failure behaviour

### Inside the primary site

- An edge failure moves the ingress VIP between HAProxy nodes.
- A MariaDB failure can move the database resource group and `10.10.20.10` to the surviving core node.
- A storage failure can move the NFS resource group and `10.10.30.10` to `san02`.
- The simulator preserves state across terminal reconnects and browser reloads, so recovery must be verified rather than assumed.

### Across sites

The recovery site is deliberately **not** an automatic failover target. The exercises require the operator to establish the primary site's condition, declare recovery readiness, promote the recovery site and perform a controlled return. This models the human decision needed when a site-level partition is ambiguous.

## Virtualisation model

`kvm01` and `kvm02` expose a small stateful libvirt-style inventory.

| Hypervisor | Simulated guests |
| --- | --- |
| `kvm01` | `web01-vm`, `api01-vm`, `ftp01-vm` |
| `kvm02` | `web02-vm`, `job01-vm`, `ftp02-vm` |

`virsh list`, `virsh console`, VM power operations, bridge configuration and `virsh edit` operate only on simulated, persisted state. The virtual file editor is intended for safe config-repair exercises.

## Exercises

The simulator contains seventeen guided exercises. Each one provides an observable symptom, recommended investigation commands and a recovery criterion. The root cause stays hidden until requested.

| Area | Example failure class | What a successful recovery proves |
| --- | --- | --- |
| HAProxy | stale PID or invalid configuration | The service starts with a valid configuration. |
| Database | MariaDB failure or stale Pacemaker failed action | The writer and database VIP have a healthy owner. |
| Replication | MySQL duplicate key `1062` | The replica SQL thread runs again after an explicit repair. |
| DRBD | blocked port or split brain | Peers are connected with a safe primary/secondary role. |
| Storage | full filesystem or active SAN node offline | NFS service is restored without an unsafe second interruption. |
| FTP | expired TLS certificate and blocked passive range | Encrypted passive transfers are available. |
| Virtual networking | bridge slave on the wrong master | The correct bridge and guest connectivity are restored. |
| RabbitMQ | Erlang cookie mismatch | All three nodes are cluster members. |
| Cassandra | invalid listen address | All three nodes return `UN`. |
| Elasticsearch | shard allocation disabled | Cluster health is green with no unassigned shards. |
| Site recovery | primary unreachable, recovery promotion, controlled return | Request routing changes only after deliberate validation. |

## Run an exercise like an incident

The lab is more useful when a repair is treated as an incident, not a command-completion task. Use this short loop during each exercise:

1. **Impact** - state what a user or dependent service cannot do.
2. **Status** - separate confirmed evidence from assumptions; use the service log, cluster status and VIP state.
3. **Action** - name the next safe check or repair, and avoid changing two variables at once.
4. **Verification** - prove recovery from the service path, not only `systemctl status`.
5. **Record** - write a short timeline, root cause, corrective action and what would have detected the issue earlier.

For learning purposes, prioritise by impact and scope:

| Priority | Lab example | First objective |
| --- | --- | --- |
| P1 | database write path unavailable or DRBD split brain | Protect data and restore a single safe writer. |
| P2 | one HAProxy node failed or replication stalled | Restore redundancy before a second fault becomes an outage. |
| P3 | FTP passive range missing or storage capacity warning | Apply a safe workaround and prevent escalation. |
| P4 | planned certificate renewal or capacity change | Perform through a documented change and verify the outcome. |

## Try the core failover flow

```bash
ssh root@mysql-core01
systemctl stop mariadb
pcs status
exit
ssh root@mysql-core02
ip a | grep 10.10.20.10
drbdadm status
exit
ssh root@mysql-slave01
mysql -e "SHOW SLAVE STATUS\G"
```

The goal is not to memorise commands. Read the cluster state, establish which node owns the database VIP, check that DRBD and replication agree, and confirm that the model reports a healthy service path.

## Scope boundaries

This repository intentionally does **not** simulate every Linux command, physical network, cloud API, authentication system or production control plane. Unsupported commands report that they are unavailable instead of silently pretending to work.

All names, addresses, credentials, configuration fragments and incidents are fictional. They exist only to support learning and interview discussion; they are not copied from an employer or client system.
