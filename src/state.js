export const STORAGE_KEY = "ha-infrastructure-lab.v1";
export const STATE_VERSION = 9;

const primary = [
  ["dns01", "10.10.50.11", "DNS / health routing"], ["haproxy01", "10.10.10.21", "HAProxy active"], ["haproxy02", "10.10.10.22", "HAProxy standby"],
  ["varnish01", "10.10.11.21", "Varnish cache"], ["varnish02", "10.10.11.22", "Varnish cache"], ["web01", "10.10.12.21", "Nginx / PHP-FPM"], ["web02", "10.10.12.22", "Nginx / PHP-FPM"], ["web03", "10.10.12.23", "Lighttpd / PHP-FPM"],
  ["mysql-core01", "10.10.20.21", "MySQL primary / DRBD Primary"], ["mysql-core02", "10.10.20.22", "MySQL standby / DRBD Secondary"], ["mysql-slave01", "10.10.20.31", "MySQL read replica"],
  ["san01", "10.10.30.21", "NFS active / DRBD Primary"], ["san02", "10.10.30.22", "NFS standby / DRBD Secondary"],
  ...["rabbitmq", "cassandra", "elasticsearch"].flatMap((p) => [1,2,3].map(n => [`${p}0${n}`, `10.10.${p === "rabbitmq" ? 60 : p === "cassandra" ? 61 : 62}.${20+n}`, `${p[0].toUpperCase()+p.slice(1)} cluster`])),
  ["ftp01", "10.10.14.21", "Pure-FTPd"], ["ftp02", "10.10.14.22", "Pure-FTPd"], ["kvm01", "10.10.40.11", "KVM hypervisor"], ["kvm02", "10.10.40.12", "KVM hypervisor"], ["mon01", "10.10.70.11", "Monitoring / logs"]
];
const recoveryServices = ["haproxy", "varnish", "web", "mysql-core", "mysql-slave", "san", "rabbitmq", "cassandra", "elasticsearch", "ftp", "kvm", "mon"];
const serviceCount = { haproxy:2, varnish:2, web:3, "mysql-core":2, "mysql-slave":1, san:2, rabbitmq:3, cassandra:3, elasticsearch:3, ftp:2, kvm:2, mon:1 };

function serviceFor(name) {
  if (name.includes("haproxy")) return { haproxy:"active (running)", keepalived:"active (running)" };
  if (name.includes("mysql")) return { mariadb:"active (running)", pacemaker:"active (running)", corosync:"active (running)", drbd:"active (running)" };
  if (/^(dr-)?san\d{2}$/.test(name)) return { "nfs-server":"active (running)", pacemaker:"active (running)", corosync:"active (running)", drbd:"active (running)" };
  if (name.includes("web")) return { nginx:"active (running)", "php-fpm":"active (running)" };
  if (name.includes("varnish")) return { varnish:"active (running)" };
  if (name.includes("ftp")) return { "pure-ftpd":"active (running)" };
  if (name.includes("rabbitmq")) return { "rabbitmq-server":"active (running)" };
  if (name.includes("cassandra")) return { cassandra:"active (running)" };
  if (name.includes("elastic")) return { elasticsearch:"active (running)" };
  if (name.includes("kvm")) return { libvirtd:"active (running)", NetworkManager:"active (running)" };
  return { chronyd:"active (running)", rsyslog:"active (running)" };
}

function filesFor(host, dc="primary") {
  const storageVip = dc === "primary" ? "10.10.30.10" : "10.20.30.10";
  const base = {
    "/etc/hosts": "127.0.0.1 localhost localhost.localdomain\n10.10.50.11 dns01.lab.internal dns01\n10.10.20.10 db-vip.lab.internal db-vip\n10.10.30.10 san-vip.lab.internal san-vip\n",
    "/etc/resolv.conf": "search lab.internal\nnameserver 10.10.50.11\nnameserver 10.20.50.11\n",
    "/etc/fstab": `UUID=lab-root / xfs defaults 0 0\n${storageVip}:/exports/app /srv/app nfs4 _netdev 0 0\n`,
    "/var/log/messages": `Aug 01 10:12:00 ${host} systemd[1]: Started Lab infrastructure services.\n`,
    "/var/log/secure": `Aug 01 10:12:11 ${host} sshd[1001]: Accepted publickey for labadmin from 10.10.0.10\n`,
    "/etc/corosync/corosync.conf": "totem { version: 2\n  cluster_name: lab-ha\n  transport: knet\n}\nnodelist { node { name: mysql-core01 nodeid: 1 } node { name: mysql-core02 nodeid: 2 } }\n",
    "/proc/drbd": "version: 9.0.28 (api:2/proto:118-122)\n 0: cs:Connected ro:Primary/Secondary ds:UpToDate/UpToDate C r-----\n"
  };
  if (host.includes("haproxy")) base["/etc/haproxy/haproxy.cfg"] = "global\n  log 127.0.0.1 local0\n  pidfile /run/haproxy.pid\ndefaults\n  mode http\n  timeout connect 5s\nfrontend public_http\n  bind *:80\n  default_backend app_pool\nbackend app_pool\n  balance roundrobin\n  server web01 10.10.12.21:80 check\n  server web02 10.10.12.22:80 check\n  server web03 10.10.12.23:80 check\n";
  if (host.includes("haproxy")) { base["/var/log/haproxy.log"]=`Aug 02 09:00:11 ${host} haproxy[2188]: Proxy public_http started.\nAug 02 09:00:11 ${host} haproxy[2188]: Backend app_pool has 3 healthy servers.\n`; base["/var/log/pacemaker/pacemaker.log"]=`Aug 02 09:00:08 ${host} pacemaker-controld[1402]: notice: State transition S_NOT_DC -> S_IDLE\n`; }
  if (host.includes("mysql")) base["/etc/my.cnf"] = "[mysqld]\nserver_id=101\ngtid_mode=ON\nlog_bin=mysql-bin\nbind-address=0.0.0.0\n";
  if (host.includes("mysql")) { base["/var/log/mariadb/mariadb.log"]=`2026-08-02 09:00:14 0 [Note] mariadbd: ready for connections on ${host}\n`; base["/var/log/drbd.log"]=`Aug 02 09:00:07 ${host} kernel: drbd r0: peer connection established; replication Connected\n`; base["/var/log/pacemaker/pacemaker.log"]=`Aug 02 09:00:09 ${host} pacemaker-controld[1402]: notice: Database resource group is healthy\n`; }
  if (host.includes("san")) base["/etc/exports"] = "/exports/app 10.10.0.0/16(rw,sync,no_root_squash)\n/exports/backups 10.10.0.0/16(rw,sync,root_squash)\n";
  if (host.includes("san")) { base["/var/log/nfs.log"]=`Aug 02 09:00:12 ${host} rpc.mountd[2011]: Version 2.3.3 starting; exports ready\n`; base["/var/log/drbd.log"]=`Aug 02 09:00:07 ${host} kernel: drbd storage: replication Connected, disk UpToDate\n`; base["/var/log/pacemaker/pacemaker.log"]=`Aug 02 09:00:09 ${host} pacemaker-controld[1402]: notice: Storage resource group is healthy\n`; }
  if (host.includes("ftp")) { base["/etc/pure-ftpd/pure-ftpd.conf"] = "ChrootEveryone yes\nNoAnonymous yes\nTLS 2\nPassivePortRange 30000 31000\nMaxClientsNumber 80\nPureDB /etc/pure-ftpd/pureftpd.pdb\nCertFile /etc/pki/tls/certs/lab-ftp.pem\n"; base["/etc/pki/tls/certs/lab-ftp.pem"]="LAB FTP CERTIFICATE serial=2026-01 expires=2027-08-01\n";base["/etc/pki/tls/certs/lab-ftp-renewed.pem"]="LAB FTP CERTIFICATE serial=2026-02 expires=2027-08-01\n";base["/var/log/pureftpd.log"] = `Aug 01 10:14:03 ${host} pure-ftpd[2210]: FTP service ready (TLS required)\n`; }
  if(host.includes("varnish"))base["/var/log/varnish/varnish.log"]=`Aug 02 09:00:12 ${host} varnishd[2202]: Child started; cache healthy\n`;
  if(host.includes("web"))base["/var/log/nginx/error.log"]=`2026/08/02 09:00:13 [notice] 2110#0: nginx worker processes started on ${host}\n`;
  if(host.includes("rabbitmq")){base["/etc/rabbitmq/lab.erlang.cookie"]="LAB-CLUSTER-COOKIE\n";base["/var/lib/rabbitmq/.erlang.cookie"]="LAB-CLUSTER-COOKIE\n";base[`/var/log/rabbitmq/rabbit@${host}.log`]=`2026-08-02 09:00:15.011 [info] <0.44.0> Cluster node ${host} is ready\n`;}
  if(host.includes("cassandra")){const node=Number(host.match(/(\d{2})$/)?.[1]||1),address=host.startsWith("dr-")?`10.20.10.${20+node}`:`10.10.61.${20+node}`;base["/etc/cassandra/cassandra.yaml"]=`cluster_name: 'lab-cassandra'\nlisten_address: ${address}\nrpc_address: 0.0.0.0\nendpoint_snitch: GossipingPropertyFileSnitch\n`;base["/var/log/cassandra/system.log"]=`INFO  [main] 2026-08-02 09:00:16 ${host} - Node state jump to NORMAL\n`;}
  if(host.includes("elasticsearch"))base["/var/log/elasticsearch/lab-search.log"]=`[2026-08-02T09:00:17,011][INFO ][o.e.n.Node] [${host}] started\n`;
  if(host.includes("kvm"))base["/var/log/libvirt/libvirtd.log"]=`2026-08-02 09:00:20.011+0000: info : libvirt daemon started on ${host}\n`;
  if(host.includes("mon"))base["/var/log/monitoring/alerts.log"]=`2026-08-02 09:00:21 INFO all fictional lab checks healthy\n`;
  return base;
}

function directoriesFor(files,username="labadmin"){
  const directories=new Set(["/","/root","/home",`/home/${username}`,"/tmp","/var","/var/log","/etc","/srv","/srv/app","/exports","/exports/app"]);
  for(const path of Object.keys(files)){let parent=path.slice(0,path.lastIndexOf("/"))||"/";while(parent!=="/"){directories.add(parent);parent=parent.slice(0,parent.lastIndexOf("/"))||"/";}}
  return [...directories].sort();
}

function makeHost([hostname, ip, role], dc="primary") {
  const files=filesFor(hostname,dc),storageVip=dc==="primary"?"10.10.30.10":"10.20.30.10",isHypervisor=hostname.includes("kvm"),connections=isHypervisor?{br0:{type:"bridge",device:"br0",state:"up",address:`${ip}/24`},br1:{type:"bridge",device:"br1",state:"up",address:dc==="primary"?"10.10.40.10/24":"10.20.40.10/24"},"bridge-br1":{type:"ethernet",device:"eno2",state:"up",master:"br1"}}:{ens192:{type:"ethernet",device:"ens192",state:"up",address:`${ip}/24`}};
  return { hostname, ip, role, dc, online:true, uptime: "3 days, 06:42", load:"0.08, 0.05, 0.01", disk: /^(dr-)?san\d{2}$/.test(hostname) ? 61 : 34, dataDisk: 61, memory: hostname.includes("mysql") ? 43 : 27, services:serviceFor(hostname), files,directories:directoriesFor(files), history:[], interfaces:[{name:"lo",ip:"127.0.0.1/8",state:"UP"},{name:"ens192",ip:`${ip}/24`,state:"UP"}], routes:[`default via ${dc==="primary"?"10.10":"10.20"}.0.1 dev ens192`, `${dc==="primary"?"10.10":"10.20"}.0.0/16 dev ens192 proto kernel scope link src ${ip}`], connections, users:{root:{uid:0,groups:"root"},labadmin:{uid:1101,groups:"labadmin,wheel"}}, mounts:["/dev/mapper/lab-root on / type xfs (rw,relatime)",`${storageVip}:/exports/app on /srv/app type nfs4 (rw,relatime,_netdev)`], packages:["bash-4.4.20-8.el8.x86_64","systemd-239-74.el8.x86_64","openssh-server-8.0p1-25.el8.x86_64"], boot:"2026-07-29 03:30" };
}

export function createInitialState() {
  const hosts = Object.fromEntries(primary.map(h => [h[0], makeHost(h)]));
  recoveryServices.forEach(prefix => { for(let n=1; n<=serviceCount[prefix]; n++) { const hostname=`dr-${prefix}${String(n).padStart(2,"0")}`; const ip=`10.20.${prefix === "mysql-core" ? 20 : prefix === "san" ? 30 : 10}.${20+n}`; hosts[hostname]=makeHost([hostname,ip,`Recovery ${prefix} standby`],"recovery"); } });
  hosts.bastion01 = makeHost(["bastion01","10.10.0.10","Lab access gateway"]);
  hosts["mysql-core02"].services.mariadb="inactive (dead)";hosts.san02.services["nfs-server"]="inactive (dead)";
  if(hosts["dr-mysql-core02"])hosts["dr-mysql-core02"].services.mariadb="inactive (dead)";if(hosts["dr-san02"])hosts["dr-san02"].services["nfs-server"]="inactive (dead)";
  const vms={"web01-vm":{hypervisor:"kvm01",guest:"web01",vcpus:4,memoryMiB:8192},"api01-vm":{hypervisor:"kvm01",guest:"web02",vcpus:4,memoryMiB:8192},"ftp01-vm":{hypervisor:"kvm01",guest:"ftp01",vcpus:2,memoryMiB:4096},"web02-vm":{hypervisor:"kvm02",guest:"web03",vcpus:4,memoryMiB:8192},"job01-vm":{hypervisor:"kvm02",guest:"mon01",vcpus:2,memoryMiB:4096},"ftp02-vm":{hypervisor:"kvm02",guest:"ftp02",vcpus:2,memoryMiB:4096}};
  return { version:STATE_VERSION, activeDc:"primary", dnsTarget:"primary", time:"2026-08-02 09:05:00", hosts,vms,
    clusters:{haproxy:{nodes:["haproxy01","haproxy02"],vip:"10.10.10.10",owner:"haproxy01",dc:"haproxy01",quorum:true}, database:{nodes:["mysql-core01","mysql-core02"],vip:"10.10.20.10",owner:"mysql-core01",dc:"mysql-core01",quorum:true,drbd:"Connected",roles:"Primary/Secondary"}, storage:{nodes:["san01","san02"],vip:"10.10.30.10",owner:"san01",dc:"san01",quorum:true,drbd:"Connected",roles:"Primary/Secondary"}},
    mysql:{primary:"mysql-core01", replica:"mysql-slave01", gtid:"lab-uuid:1-8421", log:"mysql-bin.000042",position:195234, io:true, sql:true, lag:0, channel:"primary01-dr01", error:"",skipCounterReady:false},
    firewall:{}, ftp:{tlsValid:true,passiveOpen:true,reloaded:true}, elastic:"green",elasticAllocation:"all", rabbitOnline:3, cassandraOnline:3, snapshots:[], events:[{time:"10:15",type:"info",message:"Clean lab topology initialized."}], scenarios:{} };
}

function migrateState(saved){const clean=createInitialState();for(const [name,seed] of Object.entries(clean.hosts)){if(!saved.hosts?.[name]){saved.hosts??={};saved.hosts[name]=seed;continue;}const host=saved.hosts[name],priorServices=host.services||{};host.files={...seed.files,...host.files};host.directories=[...new Set([...(host.directories||[]),...directoriesFor(host.files),...seed.directories])].sort();host.services=Object.fromEntries(Object.entries(seed.services).map(([service,defaultState])=>[service,priorServices[service]??(service==="nfs-server"?priorServices.nfs_server:undefined)??defaultState]));host.users={...seed.users,...host.users};host.dataDisk??=seed.dataDisk;host.serviceMeta??={};host.connections={...seed.connections,...host.connections};host.interfaces??=seed.interfaces;host.routes??=seed.routes;host.mounts??=seed.mounts;host.packages??=seed.packages;}for(const name of Object.keys(saved.hosts||{}))if(!clean.hosts[name])delete saved.hosts[name];saved.vms??=clean.vms;saved.clusters??=clean.clusters;for(const [name,cluster] of Object.entries(saved.clusters)){cluster.dc??=clean.clusters[name]?.dc||cluster.owner;if(!saved.hosts[cluster.dc]?.online)cluster.dc=cluster.nodes.find(node=>saved.hosts[node].online)||null;if(name==="database")cluster.nodes.forEach(node=>saved.hosts[node].services.mariadb=node===cluster.owner&&saved.hosts[node].online?"active (running)":"inactive (dead)");if(name==="storage")cluster.nodes.forEach(node=>saved.hosts[node].services["nfs-server"]=node===cluster.owner&&saved.hosts[node].online?"active (running)":"inactive (dead)");}saved.mysql={...clean.mysql,...saved.mysql};saved.firewall??={};saved.ftp??={...clean.ftp};saved.elasticAllocation??="all";saved.events??=clean.events;saved.scenarios??={};delete saved.scenarios[11];delete saved.scenarios[12];delete saved.scenarios[17];saved.snapshots??=[];const storageRun=saved.scenarios[9];if(storageRun?.status==="completed"&&!saved.hosts.san01.online){storageRun.status="in_progress";storageRun.active=true;delete storageRun.completedAt;storageRun.lastCheck="Exercise reopened: san01 is still offline. Rejoin the node and verify storage service health.";event(saved,"warning","Exercise 9 reopened because san01 remains offline.");}for(const [id,run] of Object.entries(saved.scenarios)){if(!run.historyBaseline){run.historyBaseline=Object.fromEntries(Object.entries(saved.hosts).map(([name,host])=>[name,(host.history||[]).length]));if(Number(id)>=18){run.status="in_progress";run.active=true;run.lastCheck="Site controls updated. Restart this incident to run the declaration/promotion/return workflow.";delete run.completedAt;}}}saved.version=STATE_VERSION;return saved;}
const legacyIncidentEvidence={
  1:["haproxy01","/var/log/haproxy.log","CRITICAL health check process terminated; active load balancer unavailable"],2:["haproxy01","/var/log/haproxy.log","ALERT fatal configuration errors: unknown keyword 'INVALID' in /etc/haproxy/haproxy.cfg"],3:["mysql-core01","/var/log/mariadb/mariadb.log","CRITICAL mariadbd exited unexpectedly; clustered recovery requested"],4:["mysql-slave01","/var/log/mariadb/mariadb.log","ERROR Replica SQL thread stopped: duplicate key error 1062"],5:["mysql-core01","/var/log/drbd.log","WARNING r0 peer connection lost; replication Disconnected"],6:["mysql-core01","/var/log/drbd.log","ALERT Split-Brain detected; roles Primary/Primary"],7:["mysql-core01","/var/log/pacemaker/pacemaker.log","NOTICE database VIP migration requested"],8:["san01","/var/log/nfs.log","CRITICAL filesystem usage reached 98%; core file consuming /tmp"],9:["san01","/var/log/nfs.log","CRITICAL NFS service monitor timed out; storage failover initiated"],10:["ftp01","/var/log/pureftpd.log","ERROR TLS handshake failed; passive data connection refused"],13:["kvm01","/var/log/libvirt/libvirtd.log","ERROR bridge br1 is down; virtual machine backend connectivity lost"],14:["rabbitmq01","/var/log/rabbitmq/rabbit@rabbitmq01.log","ERROR cluster heartbeat lost; node marked down"],15:["cassandra01","/var/log/cassandra/system.log","ERROR failure detector marked node DOWN"],16:["elasticsearch02","/var/log/elasticsearch/lab-search.log","ERROR cluster status RED; primary shards unassigned"],18:["dns01","/var/log/messages","CRITICAL primary data-centre health checks failed"],19:["dr-haproxy01","/var/log/pacemaker/pacemaker.log","NOTICE recovery promotion exercise: inspect site control status before switching the request path"],20:["haproxy01","/var/log/pacemaker/pacemaker.log","NOTICE controlled-return exercise: inspect site control status before restoring the primary request path"]
};
export function ensureScenarioLogEvidence(state){for(const [id,run] of Object.entries(state.scenarios||{})){if(!run?.active)continue;const evidence=legacyIncidentEvidence[id];if(!evidence)continue;const [hostname,path,message]=evidence,host=state.hosts?.[hostname],marker=`[scenario:${id}]`;if(host&&!(host.files[path]||"").includes(marker)){host.files[path]=(host.files[path]||"")+`Aug 02 09:20:00 ${hostname} lab-incident[400${id}]: ${marker} ${message}\n`;host.files["/var/log/messages"]=(host.files["/var/log/messages"]||"")+`Aug 02 09:20:00 ${hostname} lab-incident[400${id}]: ${marker} ${message}\n`;}}return state;}
export function loadState() { try { const saved=localStorage.getItem(STORAGE_KEY);if(!saved)return createInitialState();const parsed=JSON.parse(saved);return (parsed.version||0)<STATE_VERSION?createInitialState():ensureScenarioLogEvidence(migrateState(parsed)); } catch { return createInitialState(); } }
export function saveState(state) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
export function resetState() { const state=createInitialState(); saveState(state); return state; }
export function event(state,type,message) { state.events.unshift({time:new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}),type,message}); state.events=state.events.slice(0,25); }
export const aliases = { db01:"mysql-core01", db02:"mysql-core02", "san-vip":"san01", "db-vip":"mysql-core01", "lb-vip":"haproxy01" };
