# Architecture

A two-site high-availability reference design for a customer-facing e-commerce platform, and the estate the simulator in this repository models. Every hostname, address and credential below is fictional; addressing uses RFC 1918 (10.0.0.0/8) and RFC 5737 documentation ranges (203.0.113.0/24, 198.51.100.0/24).

- [Design goals](#design-goals)
- [Topology](#topology)
- [Addressing and VLAN plan](#addressing-and-vlan-plan)
- [VIP inventory](#vip-inventory)
- [Design rules](#design-rules)
- [Layer 1 — Edge](#layer-1--edge-haproxy--keepalived)
- [Layer 2 — Database core](#layer-2--database-core-pacemaker-corosync-drbd)
- [Layer 3 — MySQL replication](#layer-3--mysql-replication)
- [Layer 4 — Storage](#layer-4--storage-drbd--nfsv4)
- [Layer 5 — Web tier](#layer-5--web-tier)
- [Layer 6 — Virtualisation](#layer-6--virtualisation)
- [Layer 7 — Transfer, queue, search](#layer-7--transfer-queue-search)
- [Layer 8 — Site failover](#layer-8--site-failover)
- [Failure drills](#failure-drills)

---

## Design goals

1. **No single point of failure inside a site.** Every tier is at least a pair, and no pair shares a hypervisor.
2. **One writer, always.** Availability must never be bought with a second Primary.
3. **Automatic inside a site, manual between them.** A partition between data centres is indistinguishable from a dead data centre; only a human declares a site loss.
4. **A running process is not a healthy service.** Every health check tests the service path, not the unit state.

---

## Topology

Request path, left to right:

```
                  ┌──────────────────── DC-A · 10.10.0.0/16 (active) ────────────────────┐
 client ──▶ DNS ──▶ edge VIP 10.10.10.10 ──▶ haproxy01 / haproxy02   (keepalived VRRP 51)
                          │
                          ├──▶ varnish01 / varnish02          (cache, grace 6h)
                          │
                          └──▶ web01 / web02 / web03          (Nginx + PHP-FPM, one Apache)
                                    │
                                    ├──▶ db VIP  10.10.20.10 ──▶ mysql-core01 ⇄ mysql-core02
                                    │                             (DRBD proto C, Pacemaker)
                                    │                          └─▶ mysql-slave01  (GTID read)
                                    │
                                    ├──▶ san VIP 10.10.30.10 ──▶ san01 ⇄ san02
                                    │                             (DRBD + NFSv4, Pacemaker)
                                    │
                                    └──▶ rabbitmq01-03 · cassandra01-03 · elasticsearch01-03

                    kvm01 / kvm02   host the web, ftp and job guests (br0 public, br1 private)
                    mon01           Icinga, rsyslog, corosync qdevice
                    bastion01       the only SSH ingress

                  └──────────────────────────────────────────────────────────────────────┘
                                            ║
                    10 Gb dark fibre, 3 ms  ║  MySQL GTID async · Cassandra NTS ring
                                            ║  Elasticsearch CCR · hourly rsync of /exports
                                            ║
                  ┌──────────── DC-B · 10.20.0.0/16 (warm recovery) ─────────────────────┐
                    dr- prefixed mirror of every node above, same VLAN numbering.
                    Cluster resources exist but are stopped until promotion.
                  └──────────────────────────────────────────────────────────────────────┘
```

### DC-A node inventory

| Node | Address | Role |
| --- | --- | --- |
| dns01 | 10.10.50.11 | BIND, health-checked A records |
| haproxy01 | 10.10.10.21 | HAProxy, keepalived MASTER |
| haproxy02 | 10.10.10.22 | HAProxy, keepalived BACKUP |
| varnish01 / 02 | 10.10.11.21 / .22 | Varnish 6, port 6081 |
| web01 / web02 | 10.10.12.21 / .22 | Nginx + PHP-FPM (KVM guests) |
| web03 | 10.10.12.23 | Apache + cPanel/WHM |
| mysql-core01 | 10.10.20.21 | MariaDB writer, DRBD Primary |
| mysql-core02 | 10.10.20.22 | Standby, DRBD Secondary |
| mysql-slave01 | 10.10.20.31 | GTID read replica, reporting |
| san01 / san02 | 10.10.30.21 / .22 | NFSv4 export pair, DRBD |
| ftp01 / ftp02 | 10.10.14.21 / .22 | Pure-FTPd, TLS required |
| smtp01 / cron01 | 10.10.14.31 / .32 | Postfix relay, batch jobs |
| rabbitmq01–03 | 10.10.60.21 – .23 | Quorum queues, majority of three |
| cassandra01–03 | 10.10.61.21 – .23 | NTS RF 3 per DC, LOCAL_QUORUM |
| elasticsearch01–03 | 10.10.62.21 – .23 | 3 master-eligible, 1 replica/shard |
| kvm01 / kvm02 | 10.10.40.11 / .12 | libvirt hosts, br0 public / br1 private |
| mon01 | 10.10.70.11 | Icinga, rsyslog, corosync qdevice |
| bastion01 | 10.10.0.10 | Only SSH ingress, MFA |

DC-B mirrors this list with a `dr-` prefix on 10.20.0.0/16, identical VLAN numbering.

---

## Addressing and VLAN plan

| VLAN | DC-A | DC-B | Purpose |
| --- | --- | --- | --- |
| 0 | 10.10.0.0/24 | 10.20.0.0/24 | Management / bastion |
| 10 | 10.10.10.0/24 | 10.20.10.0/24 | Edge / load balancers |
| 11 | 10.10.11.0/24 | 10.20.11.0/24 | Cache |
| 12 | 10.10.12.0/24 | 10.20.12.0/24 | Web |
| 14 | 10.10.14.0/24 | 10.20.14.0/24 | Transfer, mail, jobs |
| 20 | 10.10.20.0/24 | 10.20.20.0/24 | Database |
| 21 | 10.10.21.0/24 | 10.20.21.0/24 | Corosync ring 1 (redundant heartbeat) |
| 30 | 10.10.30.0/24 | 10.20.30.0/24 | Storage |
| 40 | 10.10.40.0/24 | 10.20.40.0/24 | Hypervisor management, live migration |
| 50 | 10.10.50.0/24 | 10.20.50.0/24 | DNS |
| 60 / 61 / 62 | 10.10.6x.0/24 | 10.20.6x.0/24 | RabbitMQ / Cassandra / Elasticsearch |
| 70 | 10.10.70.0/24 | 10.20.70.0/24 | Monitoring and logging |
| 90 | 10.10.90.0/24 | 10.20.90.0/24 | Out-of-band / IPMI (fencing) |

Only the two edge VIPs are reachable from outside. Everything below the edge is private.

---

## VIP inventory

| VIP | Service | Owner mechanism | Members | Failover trigger | Target |
| --- | --- | --- | --- | --- | --- |
| 10.10.10.10 | HTTP/HTTPS ingress | keepalived VRRP 51, `track_script` on haproxy | haproxy01, haproxy02 | 2 missed adverts or chk_haproxy fails twice | &lt; 3 s |
| 10.10.20.10 | MySQL writes | Pacemaker `db-core-group`, colocated with DRBD Promoted | mysql-core01/02 | monitor op fails, node fenced via IPMI | 45–90 s |
| 10.10.30.10 | NFSv4 export | Pacemaker `storage-group`, colocated with DRBD Promoted | san01/02 | monitor op fails, node fenced | 60 s + client grace |
| 10.20.10.10 | DC-B ingress | keepalived VRRP 61 | dr-haproxy01/02 | as above, within DC-B | &lt; 3 s |
| 10.20.20.10 | DC-B MySQL writes | Pacemaker, resources stopped until promotion | dr-mysql-core01/02 | manual | by declaration |
| 10.20.30.10 | DC-B NFS export | Pacemaker, resources stopped until promotion | dr-san01/02 | manual | by declaration |

Two mechanisms, on purpose. The edge is stateless, so VRRP's sub-second move is exactly right. The database and storage VIPs must be *ordered against data* — a VIP that arrives before DRBD promotes is a split brain waiting to happen — so those belong to Pacemaker.

---

## Design rules

**Fencing is not optional.** Two-node Pacemaker with `stonith-enabled=false` is a demo, not a cluster. Both pairs carry `fence_ipmilan` against the out-of-band cards on VLAN 90, plus a corosync qdevice on mon01 so quorum survives a node loss without `two_node` heuristics.

**Automatic inside a site, manual between them.** Intra-site failover is automatic because the failure domain is one machine. Cross-site promotion is a human decision.

**Stickiness over preference.** `resource-stickiness=200` against a location preference of 100, so a recovered node does *not* drag the VIP back during business hours. Failback is a scheduled action, not a side effect of a server finishing its boot.

**Replicas point at VIPs, not at nodes.** A failover must not orphan the read tier.

---

## Layer 1 — Edge (HAProxy + keepalived)

Two identical L7 proxies; only one holds the VIP. HAProxy terminates TLS, splits static from dynamic, and owns the health checks that decide whether a web node exists. Keepalived owns nothing but the address — and it watches HAProxy, so a proxy that dies without the box dying still moves the VIP.

Choices worth defending:

- **`balance leastconn` on the app pool** — PHP request times are long-tailed; round-robin puts a slow checkout behind a fast one.
- **Cookie stickiness** — sessions are external, but the cart flow tolerates affinity better than a mid-checkout rebalance.
- **`slowstart 20s`** — a restarted PHP-FPM pool with a cold opcache falls over if given full share instantly.
- **Unicast peers, not multicast** — the classic "both nodes hold the VIP after a switch flaps" failure.

<details>
<summary><code>/etc/haproxy/haproxy.cfg</code></summary>

```
global
    log         127.0.0.1 local0 info
    chroot      /var/lib/haproxy
    pidfile     /run/haproxy.pid
    maxconn     40000
    user        haproxy
    group       haproxy
    daemon
    stats socket /var/lib/haproxy/stats mode 660 level admin expose-fd listeners
    ssl-default-bind-ciphers ECDHE+AESGCM:ECDHE+CHACHA20
    ssl-default-bind-options no-sslv3 no-tlsv10 no-tlsv11

defaults
    mode                 http
    log                  global
    option               httplog
    option               dontlognull
    option               forwardfor except 127.0.0.0/8
    option               http-server-close
    retries              3
    timeout connect      5s
    timeout client       60s
    timeout server       60s
    timeout http-request 10s
    timeout queue        30s
    default-server       inter 2s fall 3 rise 2 slowstart 20s

frontend fe_public
    bind 10.10.10.10:80
    bind 10.10.10.10:443 ssl crt /etc/haproxy/certs/shop.pem alpn h2,http/1.1
    http-request redirect scheme https unless { ssl_fc }
    http-request set-header X-Forwarded-Proto https if { ssl_fc }
    acl is_static   path_end .jpg .png .css .js .woff2
    acl is_private  path_beg /checkout /cart /account
    use_backend be_web   if is_private
    use_backend be_cache if is_static
    default_backend be_cache

backend be_cache
    balance roundrobin
    option httpchk GET /healthz
    http-check expect status 200
    server varnish01 10.10.11.21:6081 check
    server varnish02 10.10.11.22:6081 check
    server web01     10.10.12.21:80   check backup

backend be_web
    balance leastconn
    cookie SRV insert indirect nocache
    option httpchk GET /healthz
    http-check expect string ok
    server web01 10.10.12.21:80 check cookie w1
    server web02 10.10.12.22:80 check cookie w2
    server web03 10.10.12.23:80 check cookie w3

listen stats
    bind 10.10.10.21:9000
    stats enable
    stats uri /haproxy?stats
    stats refresh 5s
```
</details>

<details>
<summary><code>/etc/keepalived/keepalived.conf</code> — haproxy01</summary>

```
vrrp_script chk_haproxy {
    script   "/usr/bin/pkill -0 haproxy"
    interval 2
    weight   -30
    fall     2
    rise     2
}

vrrp_instance VI_EDGE {
    state            MASTER          # BACKUP on haproxy02
    interface        ens192
    virtual_router_id 51
    priority         150             # 100 on haproxy02
    advert_int       1
    preempt_delay    30
    unicast_src_ip   10.10.10.21
    unicast_peer     { 10.10.10.22 }
    authentication   { auth_type PASS  auth_pass __REDACTED__ }
    virtual_ipaddress { 10.10.10.10/24 dev ens192 }
    track_script     { chk_haproxy }
    notify           /usr/local/sbin/vrrp-notify.sh
}
```
</details>

---

## Layer 2 — Database core (Pacemaker, Corosync, DRBD)

One writer, ever. DRBD protocol C mirrors the LVM volume synchronously between the two core nodes; Pacemaker promotes exactly one to Primary, mounts `/var/lib/mysql` on top of it, brings up the VIP, then starts MariaDB — strictly in that order, colocated so the group can only live where the data is authoritative.

- **Protocol C** because a lost transaction on an order table costs more than the extra millisecond.
- **The ordering constraint matters more than it looks.** Without `order promote … then start`, Pacemaker will happily start MariaDB on the Secondary's stale mount.
- **`after-sb-*` policies are set explicitly**, and split brain still pages a human — auto-resolution picks a victim, and the victim's writes are gone.
- **A qdevice beats `two_node: 1`.** A real third vote removes the fencing race entirely.

<details>
<summary><code>/etc/drbd.d/r0.res</code></summary>

```
resource r0 {
    protocol  C;
    device    /dev/drbd0;
    disk      /dev/vg_db/lv_data;
    meta-disk internal;

    net {
        cram-hmac-alg     sha1;
        shared-secret     "__REDACTED__";
        after-sb-0pri     discard-zero-changes;
        after-sb-1pri     discard-secondary;
        after-sb-2pri     disconnect;
        verify-alg        sha256;
        max-buffers       8000;
        sndbuf-size       1024k;
    }
    disk {
        on-io-error   detach;
        resync-rate   200M;
        fencing       resource-and-stonith;
    }
    handlers {
        fence-peer    "/usr/lib/drbd/crm-fence-peer.9.sh";
        unfence-peer  "/usr/lib/drbd/crm-unfence-peer.9.sh";
        split-brain   "/usr/lib/drbd/notify-split-brain.sh root";
    }
    on mysql-core01 { address 10.10.20.21:7789; node-id 0; }
    on mysql-core02 { address 10.10.20.22:7789; node-id 1; }
}
```
</details>

<details>
<summary><code>/etc/corosync/corosync.conf</code></summary>

```
totem {
    version:       2
    cluster_name:  db-core
    transport:     knet
    crypto_cipher: aes256
    crypto_hash:   sha256
    token:         3000
    consensus:     3600
}
nodelist {
    node { ring0_addr: 10.10.20.21  ring1_addr: 10.10.21.21  name: mysql-core01  nodeid: 1 }
    node { ring0_addr: 10.10.20.22  ring1_addr: 10.10.21.22  name: mysql-core02  nodeid: 2 }
}
quorum {
    provider:      corosync_votequorum
    # two_node: 1 only where no qdevice exists — prefer the third vote
    device {
        model: net
        votes: 1
        net { tls: on  host: 10.10.70.11  algorithm: ffsplit }
    }
}
logging { to_logfile: yes  logfile: /var/log/cluster/corosync.log  timestamp: on }
```
</details>

<details>
<summary>Cluster build — <code>pcs</code></summary>

```bash
pcs host auth mysql-core01 mysql-core02 -u hacluster
pcs cluster setup db-core mysql-core01 mysql-core02 --start --enable
pcs property set stonith-enabled=true no-quorum-policy=stop

pcs stonith create fence-core01 fence_ipmilan pcmk_host_list=mysql-core01 \
    ip=10.10.90.21 username=fence password=__REDACTED__ lanplus=1
pcs stonith create fence-core02 fence_ipmilan pcmk_host_list=mysql-core02 \
    ip=10.10.90.22 username=fence password=__REDACTED__ lanplus=1

pcs resource create drbd_r0 ocf:linbit:drbd drbd_resource=r0 \
    op monitor interval=20s role=Promoted op monitor interval=30s role=Unpromoted
pcs resource promotable drbd_r0 promoted-max=1 promoted-node-max=1 clone-max=2 notify=true

pcs resource create db_fs  Filesystem device=/dev/drbd0 directory=/var/lib/mysql \
    fstype=xfs options=noatime,nodiratime op monitor interval=20s
pcs resource create db_vip IPaddr2 ip=10.10.20.10 cidr_netmask=24 nic=ens192 \
    op monitor interval=10s
pcs resource create mariadb systemd:mariadb op monitor interval=20s timeout=60s

pcs resource group add db-core-group db_fs db_vip mariadb
pcs constraint colocation add db-core-group with Promoted drbd_r0-clone INFINITY
pcs constraint order promote drbd_r0-clone then start db-core-group
pcs resource defaults update resource-stickiness=200
pcs constraint location db-core-group prefers mysql-core01=100
```
</details>

---

## Layer 3 — MySQL replication

The clustered pair gives availability; replication gives read scale and a cross-site copy. Replicas point at `db-vip`, so a failover does not orphan them. GTID means re-pointing after a promotion is one statement instead of binlog-coordinate archaeology.

A **1062 duplicate-key stall on a replica** is the drill worth internalising. The wrong answer is `slave_skip_errors=1062` in `my.cnf`, which silently drifts the dataset forever. The right answer proves the row is identical, skips exactly one transaction, and then checksums.

<details>
<summary><code>server.cnf</code> — primary and replica</summary>

```ini
# ---- mysql-core01 (writer, on the DRBD volume) ----
[mysqld]
server_id                      = 101
gtid_domain_id                 = 0
bind-address                   = 0.0.0.0
datadir                        = /var/lib/mysql
log_bin                        = /var/lib/mysql/mysql-bin
binlog_format                  = ROW
binlog_row_image               = MINIMAL
log_slave_updates              = ON
sync_binlog                    = 1
innodb_flush_log_at_trx_commit = 1
innodb_buffer_pool_size        = 24G
innodb_log_file_size           = 2G
innodb_file_per_table          = 1
max_connections                = 1500
thread_cache_size              = 200
slow_query_log                 = 1
long_query_time                = 1
expire_logs_days               = 7

# ---- mysql-slave01 / dr-mysql-core01 (readers) ----
[mysqld]
server_id                      = 131
read_only                      = ON
super_read_only                = ON
relay_log                      = relay-bin
relay_log_recovery             = ON
slave_parallel_threads         = 4
slave_parallel_mode            = optimistic
slave_skip_errors              = OFF     # never blanket-skip
```
</details>

<details>
<summary>Attach a replica, and clear a duplicate-key stall</summary>

```sql
-- attach (replica points at the VIP, never at a node name)
CHANGE MASTER TO
  MASTER_HOST     = 'db-vip.lab.internal',
  MASTER_USER     = 'repl',
  MASTER_PASSWORD = '__REDACTED__',
  MASTER_USE_GTID = slave_pos,
  MASTER_CONNECT_RETRY = 10;
START SLAVE;
SHOW SLAVE STATUS\G

-- SQL thread stopped: Last_SQL_Errno 1062, duplicate entry '88412' for key 'PRIMARY'
STOP SLAVE SQL_THREAD;
SHOW SLAVE STATUS\G     -- note Relay_Master_Log_File, Exec_Master_Log_Pos, Gtid_IO_Pos
```

```bash
# 1. see the exact event, do not guess
mysqlbinlog --base64-output=DECODE-ROWS -vv \
  --start-position=195234 /var/lib/mysql/mysql-bin.000042 | sed -n '1,80p'
```

```sql
-- 2. prove the row on the replica already equals the row on the primary
SELECT * FROM shop.orders WHERE id = 88412;

-- 3. skip precisely one transaction
SET GLOBAL sql_slave_skip_counter = 1;          -- positional
-- or, with GTID:  SET GLOBAL gtid_slave_pos = '0-101-8422';
START SLAVE SQL_THREAD;
```

```bash
# 4. prove the datasets agree afterwards
pt-table-checksum --replicate=percona.checksums --databases=shop
pt-table-sync --print --replicate=percona.checksums h=mysql-slave01
```
</details>

---

## Layer 4 — Storage (DRBD + NFSv4)

Shared application state — uploads, invoices, the partner FTP drop — lives on a second DRBD pair exported over NFSv4. NFSv4 matters here: the lease/grace window is what lets a client survive a server move without an I/O error surfacing in PHP.

- `nfs_shared_infodir` lives on the DRBD volume so lock state moves with the data.
- Clients mount the VIP `hard,intr` — a soft mount turns a 60-second failover into corrupt uploads.
- Disk alarms at 80 % warn, 90 % page. The SAN filling is the most common real incident in this estate.

<details>
<summary><code>/etc/exports</code> and <code>storage-group</code></summary>

```
# /etc/exports  (identical on san01 and san02)
/exports/app  10.10.12.0/24(rw,sync,no_subtree_check,no_root_squash) \
              10.10.14.0/24(rw,sync,no_subtree_check,root_squash)

# client side, /etc/fstab on web0*
san-vip.lab.internal:/exports/app  /srv/app  nfs4  _netdev,hard,intr,rsize=65536,wsize=65536  0 0
```

```bash
pcs resource create drbd_storage ocf:linbit:drbd drbd_resource=storage \
    op monitor interval=20s role=Promoted
pcs resource promotable drbd_storage promoted-max=1 clone-max=2 notify=true
pcs resource create san_fs   Filesystem device=/dev/drbd1 directory=/exports \
    fstype=xfs op monitor interval=20s
pcs resource create nfs_root nfsserver nfs_shared_infodir=/exports/nfsinfo nfs_no_notify=false
pcs resource create san_vip  IPaddr2 ip=10.10.30.10 cidr_netmask=24 nic=ens192
pcs resource group add storage-group san_fs nfs_root san_vip
pcs constraint colocation add storage-group with Promoted drbd_storage-clone INFINITY
pcs constraint order promote drbd_storage-clone then start storage-group
```
</details>

---

## Layer 5 — Web tier

Varnish absorbs catalogue traffic; `grace` is the HA feature that matters — stale-while-revalidate means a backend outage degrades to slightly old pages instead of a 503 wall. Nginx fronts PHP-FPM over a unix socket. Apache stays on the cPanel node because per-account `.htaccess` and suexec semantics are the reason cPanel exists.

**Sizing rule:** `pm.max_children` is usable memory ÷ average process RSS, and it must stay below what the database can accept in connections. Three web nodes × 60 children is how you accidentally DoS your own database during a spike.

<details>
<summary>Nginx vhost and PHP-FPM pool</summary>

```nginx
# /etc/nginx/conf.d/shop.conf
upstream php_shop { server unix:/run/php-fpm/shop.sock; }

server {
    listen 80 default_server;
    server_name shop.example.com;
    root /srv/app/current/public;

    set_real_ip_from 10.10.10.0/24;
    real_ip_header   X-Forwarded-For;

    location = /healthz { access_log off; return 200 "ok\n"; }

    location / { try_files $uri /index.php$is_args$args; }

    location ~ \.php$ {
        include              fastcgi_params;
        fastcgi_pass         php_shop;
        fastcgi_param        SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_read_timeout 60s;
        fastcgi_buffers      16 16k;
    }

    # uploads live on the NFS VIP; never serve them through PHP
    location /media/ { alias /srv/app/shared/media/; expires 30d; }
}
```

```ini
# /etc/php-fpm.d/shop.conf
[shop]
listen                     = /run/php-fpm/shop.sock
listen.owner               = nginx
pm                         = dynamic
pm.max_children            = 60      # 8 GB usable / ~130 MB RSS
pm.start_servers           = 12
pm.min_spare_servers       = 8
pm.max_spare_servers       = 20
pm.max_requests            = 500     # bounds a slow leak
request_terminate_timeout  = 60s
slowlog                    = /var/log/php-fpm/shop-slow.log
request_slowlog_timeout    = 5s
```
</details>

<details>
<summary><code>/etc/varnish/default.vcl</code></summary>

```vcl
vcl 4.1;
import directors;

probe web_probe {
    .url = "/healthz"; .timeout = 1s; .interval = 3s; .window = 5; .threshold = 3;
}
backend web01 { .host = "10.10.12.21"; .port = "80"; .probe = web_probe; }
backend web02 { .host = "10.10.12.22"; .port = "80"; .probe = web_probe; }
backend web03 { .host = "10.10.12.23"; .port = "80"; .probe = web_probe; }

sub vcl_init {
    new pool = directors.round_robin();
    pool.add_backend(web01); pool.add_backend(web02); pool.add_backend(web03);
}

sub vcl_recv {
    set req.backend_hint = pool.backend();
    if (req.url ~ "^/(checkout|cart|account|admin)") { return (pass); }
    unset req.http.Cookie;
}

sub vcl_backend_response {
    set beresp.ttl   = 2m;
    set beresp.grace = 6h;    # serve stale for six hours if every backend is sick
    if (bereq.url ~ "\.(jpg|png|css|js|woff2)$") { set beresp.ttl = 7d; }
}
```
</details>

---

## Layer 6 — Virtualisation

Two hypervisors per site, guests spread so no single host holds both members of any pair. Bridged networking, not NAT — guests are first-class citizens on the VLANs. Disks are LVM logical volumes with `cache=none io=native`: page-cache double-buffering is the difference between a database guest that behaves and one that lies about durability.

Anti-affinity is enforced by hand: `web01` + `web02` on one host is acceptable; `mysql-core01` + `mysql-core02` on one host is not.

<details>
<summary>Bridges, provisioning, domain XML</summary>

```bash
# bridges — br0 public/edge, br1 private backend
nmcli con add type bridge ifname br1 con-name br1 \
      ipv4.method manual ipv4.addresses 10.10.40.10/24 bridge.stp no
nmcli con add type bridge-slave ifname eno2 con-name bridge-br1 master br1
nmcli con up br1

# provision a web guest
virt-install --name web01 --memory 8192 --vcpus 4 --cpu host-passthrough \
  --disk path=/dev/vg_kvm/web01,bus=virtio,cache=none,io=native \
  --network bridge=br1,model=virtio \
  --os-variant centos8 --location /srv/iso/CentOS-8.iso \
  --graphics none --console pty,target_type=serial \
  --extra-args "console=ttyS0 inst.ks=http://10.10.70.11/ks/web.cfg"
```

```xml
<devices>
  <disk type='block' device='disk'>
    <driver name='qemu' type='raw' cache='none' io='native' discard='unmap'/>
    <source dev='/dev/vg_kvm/web01'/>
    <target dev='vda' bus='virtio'/>
  </disk>
  <interface type='bridge'>
    <source bridge='br1'/>
    <model type='virtio'/>
    <mac address='52:54:00:1a:2b:21'/>
  </interface>
</devices>
```

```bash
virsh list --all ; virsh dominfo web01 ; virsh domiflist web01
virsh console web01
virsh migrate --live --verbose web01 qemu+ssh://kvm02.mgmt/system
```
</details>

---

## Layer 7 — Transfer, queue, search

Pure-FTPd is where partners drop catalogue feeds — TLS required, chrooted, passive port range explicitly opened. "FTP works from the server but not from outside" is nearly always the passive range or a NAT'd control channel.

RabbitMQ uses quorum queues rather than classic mirroring. Cassandra spans both DCs as one ring at LOCAL_QUORUM. Elasticsearch keeps three master-eligible nodes so a single loss cannot deadlock the election.

<details>
<summary>pure-ftpd, rabbitmq, cassandra, elasticsearch</summary>

```
# /etc/pure-ftpd/pure-ftpd.conf
ChrootEveryone     yes
NoAnonymous        yes
TLS                2                       # 2 = TLS mandatory
CertFile           /etc/pki/tls/certs/shop-ftp.pem
PassivePortRange   30000 31000
ForcePassiveIP     203.0.113.10
MaxClientsNumber   80
PureDB             /etc/pure-ftpd/pureftpd.pdb
```

```bash
firewall-cmd --permanent --add-service=ftp
firewall-cmd --permanent --add-port=30000-31000/tcp
firewall-cmd --reload

# RabbitMQ: quorum queues, majority of three
rabbitmqctl stop_app && rabbitmqctl join_cluster rabbit@rabbitmq01 && rabbitmqctl start_app
rabbitmqctl set_policy quorum "^orders\." '{"queue-type":"quorum"}' --apply-to queues
rabbitmqctl cluster_status   # every node must share /var/lib/rabbitmq/.erlang.cookie
```

```yaml
# cassandra.yaml — one ring, two DCs
cluster_name: shop-prod
listen_address: 10.10.61.21
seed_provider: [{ seeds: "10.10.61.21,10.10.61.22,10.20.61.21" }]
endpoint_snitch: GossipingPropertyFileSnitch
# ALTER KEYSPACE shop WITH replication =
#   {'class':'NetworkTopologyStrategy','DC-A':3,'DC-B':3};  reads at LOCAL_QUORUM

# elasticsearch.yml
cluster.name: shop-search
node.roles: [ master, data ]
discovery.seed_hosts: ["10.10.62.21","10.10.62.22","10.10.62.23"]
cluster.initial_master_nodes: ["elasticsearch01","elasticsearch02","elasticsearch03"]
cluster.routing.allocation.awareness.attributes: rack_id
```
</details>

---

## Layer 8 — Site failover

Cross-site cutover is a health-checked DNS change plus a promotion runbook, with the TTL at 30 s.

DNS is deliberately described as a **weak** failover primitive: resolvers ignore TTLs, browsers pin connections, and a stale client will hammer a dead VIP for minutes. Where the business needs faster than that, the honest answer is anycast or a provider-level global load balancer. DNS is what this design has, and the RTO is stated accordingly.

**Promotion order — never improvised:**

1. Stop writes in DC-A if it is reachable at all.
2. Confirm `dr-mysql-core01` has caught up (`Gtid_IO_Pos` equals the last known primary GTID).
3. `STOP SLAVE; RESET SLAVE ALL; SET GLOBAL read_only=OFF;`
4. Enable the DC-B cluster resources.
5. Warm Varnish.
6. Flip DNS.
7. Announce, with the RPO stated honestly — seconds for MySQL, up to one hour for file data.

<details>
<summary>Zone and cutover</summary>

```
; /var/named/shop.example.com.zone
$TTL 30
@       IN SOA  dns01.lab.internal. ops.example.com. ( 2026080201 900 300 604800 30 )
        IN NS   dns01.lab.internal.
        IN NS   dr-dns01.lab.internal.

; only the promoted site's record is published
shop    IN A    203.0.113.10    ; DC-A edge VIP
;shop   IN A    198.51.100.10   ; DC-B edge VIP — uncommented on promotion

; internal names follow the VIPs, not the nodes
db-vip  IN A    10.10.20.10
san-vip IN A    10.10.30.10
```

```bash
mysql -e "STOP SLAVE; RESET SLAVE ALL; SET GLOBAL read_only=OFF; SET GLOBAL super_read_only=OFF;"
pcs resource enable dr-db-core-group dr-storage-group
nsupdate -k /etc/named/ddns.key <<'EOF'
server 10.20.50.11
update delete shop.example.com. A
update add    shop.example.com. 30 A 198.51.100.10
send
EOF
dig +short shop.example.com @10.20.50.11
```
</details>

---

## Failure drills

These are grouped reference incident categories. The simulator exposes seventeen focused exercises across them; the success criterion is the point: in every case a restart can make the symptom disappear without fixing the underlying state.

| # | Tier | Symptom | Root cause | Success criterion |
| --- | --- | --- | --- | --- |
| 01 | Edge | HAProxy will not start after a crash | Stale `/run/haproxy.pid`; systemd believes an instance is alive | Both nodes active, 80/443 listening, VIP did **not** bounce |
| 02 | Edge | Config change broke the proxy | Invalid directive; `reload` kept the old process, so it only surfaced at restart | `haproxy -c -f` clean, all backends UP, syntax check added to the change checklist |
| 03 | Database | MariaDB crashed, cluster failed over | Monitor op failed; the failure record persists by design so a flapping node cannot ping-pong | No failed actions, DRBD UpToDate/UpToDate, writer matches VIP owner |
| 04 | Database | Replica stopped, duplicate key 1062 | A row was written directly on the replica, or replayed after an unclean restart | Both threads Yes, `Last_SQL_Error` empty, lag 0, `pt-table-checksum` zero diffs |
| 05 | Database | DRBD peers Disconnected | firewalld change dropped 7789/tcp — service up, second copy gone | Connected + UpToDate/UpToDate, and the rule survives reboot |
| 06 | Database | DRBD split brain, Primary/Primary | Interconnect failed while fencing was ineffective | One Primary, resync complete, and fencing that actually works |
| 07 | Storage | Filesystem at 98 % | A 56 GiB core dump — check inodes and deleted-but-open files too | Under 80 % **and** a preventive change recorded |
| 08 | Storage | Active SAN node offline | Power loss; fencing confirmed death, group relocated | Both nodes online, DRBD UpToDate both sides, no second interruption |
| 09 | Transfer | Secure FTP failing | Two stacked faults: expired certificate *and* missing passive range | External TLS upload and listing both succeed; cert expiry monitored |
| 10 | Virtualisation | Guests lost backend connectivity | Bridge slave profile reassigned to the wrong master | `bridge link show` correct, and a *guest* reaches the DB VLAN |
| 11 | Queue / search | RabbitMQ 2 of 3; Elasticsearch RED | Mismatched Erlang cookie; persistent `allocation.enable: none` | Three nodes no partitions; cluster green, zero unassigned shards |
| 12 | Site | Primary site unreachable | Dead site, or a dead link — establish which from a third vantage point | DC-B serving, and a failback plan written before DC-A powers on |

---

*All hostnames, IP addresses, credentials and configuration in this document are fictional and exist only to model a topology. Nothing here is taken from any employer or client environment.*
