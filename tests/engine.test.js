import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, ensureScenarioLogEvidence } from "../src/state.js";
import { completions, execute, injectScenario, newSession, prompt, saveEditedFile, setHostPower } from "../src/engine.js";
import { assessScenario, scenarios } from "../src/scenarios.js";

test("clean topology contains primary and recovery infrastructure",()=>{
  const state=createInitialState();
  assert.equal(state.activeDc,"primary");
  assert.equal(state.clusters.database.owner,"mysql-core01");
  assert.ok(state.hosts["dr-mysql-core01"]);
  assert.ok(state.hosts["dr-mysql-slave01"]);
  assert.equal(Object.keys(state.hosts).length,54);
  assert.ok(state.hosts.ftp01&&state.hosts.ftp02&&state.hosts["dr-ftp01"]);
  assert.equal(state.hosts.ipa01,undefined);
  assert.equal(state.hosts.vault01,undefined);
  assert.equal(state.hosts["dr-vault01"],undefined);
  assert.deepEqual(Object.keys(state.hosts.cassandra01.services),["cassandra"]);
});

test("SSH is internal and changes the simulated prompt",()=>{
  const state=createInitialState(),session=newSession();
  const output=execute(state,session,"ssh -p 7888 root@san02");
  assert.match(output,/fictional HA lab node/);
  assert.equal(session.host,"san02");
  assert.equal(prompt(session),"[root@san02 ~]#");
  execute(state,session,"exit");
  assert.equal(session.host,"bastion01");
});

test("stopping the active database fails over the VIP persistently",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@mysql-core01");
  execute(state,session,"systemctl stop mariadb");
  assert.equal(state.hosts["mysql-core01"].services.mariadb,"inactive (dead)");
  assert.equal(state.clusters.database.owner,"mysql-core02");
  assert.equal(state.mysql.primary,"mysql-core02");
  assert.match(execute(state,session,"pcs status"),/Started mysql-core02/);
});

test("Pacemaker DC is independent from ownership and always online",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@san01");
  execute(state,session,"shutdown");
  assert.equal(state.clusters.storage.owner,"san02");
  assert.equal(state.clusters.storage.dc,"san02");
  execute(state,session,"ssh root@san02");
  assert.match(execute(state,session,"pcs status"),/Current DC: san02/);
  assert.doesNotMatch(execute(state,session,"pcs status"),/Cluster name: lab-database/);
});

test("MySQL replication commands share one state engine",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@mysql-slave01");
  execute(state,session,"mysql");
  execute(state,session,"STOP SLAVE;");
  assert.equal(state.mysql.io,false);
  assert.match(execute(state,session,"SHOW REPLICA STATUS\\G"),/Replica_IO_Running: No/);
  execute(state,session,"START SLAVE;");
  assert.equal(state.mysql.io,true);
});

test("SAN core-file incident and cleanup update df state",()=>{
  const state=createInitialState(),session=newSession();
  injectScenario(state,8);
  execute(state,session,"ssh root@san01");
  assert.match(execute(state,session,"df -h"),/98%/);
  assert.match(execute(state,session,"find /tmp -maxdepth 1 -name 'core.*'"),/core\.22011/);
  execute(state,session,"rm -f /tmp/core.*");
  assert.ok(state.hosts.san01.disk<80);
});

test("du expands wildcards and rm reports directories correctly",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@san01");
  execute(state,session,"cd /var/log");
  const usage=execute(state,session,"du -sch *");
  assert.match(usage,/messages/);
  assert.match(usage,/nfs\.log/);
  assert.match(usage,/\ttotal/);
  assert.doesNotMatch(usage,/\t\*/);
  execute(state,session,"cd /var");
  assert.match(execute(state,session,"du -sch lo"),/cannot access 'lo': No such file or directory/);
  assert.match(execute(state,session,"rm log"),/cannot remove 'log': Is a directory/);
  assert.ok(state.hosts.san01.files["/var/log/messages"]);
});

test("virtual directories persist with Linux-like cd, mkdir, ls, and rm behavior",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@san01");
  assert.match(execute(state,session,"cd /does-not-exist"),/No such file or directory/);
  assert.equal(session.cwd,"/root");
  assert.equal(execute(state,session,"mkdir -p /opt/lab/archive"),"");
  assert.equal(execute(state,session,"cd /opt/lab/archive"),"");
  assert.equal(execute(state,session,"touch evidence.txt"),"");
  assert.match(execute(state,session,"ls -l"),/-rw-r--r--.*evidence\.txt/);
  execute(state,session,"cd ..");
  assert.equal(session.cwd,"/opt/lab");
  assert.match(execute(state,session,"rm archive"),/Is a directory/);
  assert.equal(execute(state,session,"rm -r archive"),"");
  assert.match(execute(state,session,"cd archive"),/No such file or directory/);
});

test("Tab completion covers commands, hosts, paths, services, PCS, and VMs",()=>{
  const state=createInitialState(),session=newSession();
  assert.ok(completions("sys",state,session).includes("systemctl"));
  assert.ok(completions("ssh root@mysql-c",state,session).includes("root@mysql-core01"));
  execute(state,session,"ssh root@san01");
  assert.ok(completions("cd /var/l",state,session).includes("/var/log/"));
  assert.ok(completions("systemctl status nfs",state,session).includes("nfs-server.service"));
  assert.ok(completions("pcs resource move storage-group san",state,session).includes("san01"));
  execute(state,session,"exit");
  execute(state,session,"ssh root@kvm01");
  assert.ok(completions("virsh reboot web",state,session).includes("web01-vm"));
});

test("HAProxy config remains invalid until the virtual file is repaired",()=>{
  const state=createInitialState(),session=newSession();
  injectScenario(state,2);
  execute(state,session,"ssh root@haproxy01");
  assert.match(execute(state,session,"haproxy -c -f /etc/haproxy/haproxy.cfg"),/Fatal errors/);
  execute(state,session,"sed -i '/INVALID/d' /etc/haproxy/haproxy.cfg");
  assert.match(execute(state,session,"haproxy -c -f /etc/haproxy/haproxy.cfg"),/valid/);
  execute(state,session,"systemctl restart haproxy");
  assert.equal(state.hosts.haproxy01.services.haproxy,"active (running)");
});

test("vi opens editable virtual content and saved changes affect validation",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@haproxy01");
  const opened=execute(state,session,"vi /etc/haproxy/haproxy.cfg");
  assert.equal(opened.editor.hostname,"haproxy01");
  assert.match(opened.editor.content,/frontend public_http/);
  saveEditedFile(state,"haproxy01",opened.editor.path,opened.editor.content+"\nINVALID editor_test\n","root");
  assert.match(execute(state,session,"haproxy -c -f /etc/haproxy/haproxy.cfg"),/Fatal errors/);
});

test("incident scenarios append matching errors to affected server logs",()=>{
  const state=createInitialState(),session=newSession();
  injectScenario(state,2);
  execute(state,session,"ssh root@haproxy01");
  assert.match(execute(state,session,"tail /var/log/haproxy.log"),/unknown keyword 'INVALID'/);
  assert.match(execute(state,session,"journalctl -u haproxy"),/fatal configuration errors/i);
});

test("DRBD incidents are visible in service logs",()=>{
  const drbdState=createInitialState(),drbdSession=newSession();
  injectScenario(drbdState,6);
  execute(drbdState,drbdSession,"ssh root@mysql-core01");
  assert.match(execute(drbdState,drbdSession,"grep -i split-brain /var/log/drbd.log"),/Split-Brain/);

});

test("older active incidents receive log evidence during state migration",()=>{
  const state=createInitialState();
  state.scenarios[2]={active:true,started:"legacy"};
  state.hosts.haproxy01.files["/var/log/haproxy.log"]="";
  ensureScenarioLogEvidence(state);
  assert.match(state.hosts.haproxy01.files["/var/log/haproxy.log"],/fatal configuration errors/);
  ensureScenarioLogEvidence(state);
  assert.equal((state.hosts.haproxy01.files["/var/log/haproxy.log"].match(/\[scenario:2\]/g)||[]).length,1);
});

test("exercise completion requires investigation and repaired state",()=>{
  const state=createInitialState(),session=newSession();
  injectScenario(state,8);
  assert.equal(assessScenario(state,8).passed,false);
  assert.match(assessScenario(state,8).message,/diagnostic/);
  execute(state,session,"ssh root@san01");
  execute(state,session,"df -h");
  assert.equal(assessScenario(state,8).passed,false);
  execute(state,session,"rm -f /tmp/core.*");
  assert.equal(assessScenario(state,8).passed,true);
});

test("failed distributed service can be repaired and completed",()=>{
  const state=createInitialState(),session=newSession();
  injectScenario(state,14);
  execute(state,session,"ssh root@rabbitmq01");
  execute(state,session,"rabbitmqctl cluster_status");
  assert.equal(assessScenario(state,14).passed,false);
  assert.match(execute(state,session,"systemctl start rabbitmq-server"),/failed/i);
  execute(state,session,"cp /etc/rabbitmq/lab.erlang.cookie /var/lib/rabbitmq/.erlang.cookie");
  execute(state,session,"systemctl start rabbitmq-server");
  assert.equal(state.rabbitOnline,3);
  assert.equal(assessScenario(state,14).passed,true);
});

test("realistic root causes survive a simple service restart",()=>{
  const cases=[
    {id:1,host:"haproxy01",command:"systemctl start haproxy",pattern:/failed/i},
    {id:10,host:"ftp01",command:"systemctl start pure-ftpd",pattern:/expired/i},
    {id:14,host:"rabbitmq01",command:"systemctl start rabbitmq-server",pattern:/failed/i},
    {id:15,host:"cassandra01",command:"systemctl start cassandra",pattern:/ConfigurationException/i}
  ];
  for(const incident of cases){const state=createInitialState(),session=newSession();injectScenario(state,incident.id);execute(state,session,`ssh root@${incident.host}`);assert.match(execute(state,session,incident.command),incident.pattern,`exercise ${incident.id} restart must fail while root cause remains`);assert.equal(assessScenario(state,incident.id).passed,false);}
});

test("MySQL error 1062 requires an explicit validated transaction skip",()=>{
  const state=createInitialState(),session=newSession();injectScenario(state,4);execute(state,session,"ssh root@mysql-slave01");execute(state,session,"mysql");
  assert.match(execute(state,session,"START SLAVE;"),/ERROR 1872/);
  assert.equal(state.mysql.sql,false);
  execute(state,session,"SET GLOBAL sql_slave_skip_counter = 1;");
  execute(state,session,"START SLAVE;");
  assert.equal(state.mysql.sql,true);
  assert.equal(state.mysql.error,"");
});

test("DRBD reconnect fails until firewalld permits peer traffic",()=>{
  const state=createInitialState(),session=newSession();injectScenario(state,5);execute(state,session,"ssh root@mysql-core01");
  assert.match(execute(state,session,"drbdadm connect all"),/refused/i);
  execute(state,session,"firewall-cmd --add-port=7789/tcp --permanent");
  assert.match(execute(state,session,"drbdadm connect all"),/refused/i);
  execute(state,session,"firewall-cmd --reload");
  assert.equal(execute(state,session,"drbdadm connect all"),"");
  assert.equal(state.clusters.database.drbd,"Connected");
});

test("yum rejects misspelled packages and installed telnet follows DRBD firewall state",()=>{
  const state=createInitialState(),session=newSession();injectScenario(state,5);execute(state,session,"ssh root@mysql-core01");
  assert.match(execute(state,session,"telnet 10.10.20.22 7789"),/command not found/);
  assert.match(execute(state,session,"yum install telent"),/No match for argument: telent/);
  assert.equal(state.hosts["mysql-core01"].packages.some(pkg=>pkg.startsWith("telent-")),false);
  assert.match(execute(state,session,"yum install telnet"),/Installed/);
  assert.match(execute(state,session,"telnet 10.10.20.22 7789"),/Connection refused/);
  execute(state,session,"firewall-cmd --add-port=7789/tcp --permanent");
  execute(state,session,"firewall-cmd --reload");
  assert.match(execute(state,session,"telnet 10.10.20.22 7789"),/Connected to 10\.10\.20\.22/);
});

test("firewall-cmd rejects two commands entered without a shell separator",()=>{
  const state=createInitialState(),session=newSession();injectScenario(state,5);execute(state,session,"ssh root@mysql-core01");
  const malformed=execute(state,session,"sudo firewall-cmd --permanent --add-port=7789/tcp sudo firewall-cmd --reload");
  assert.match(malformed,/unrecognized arguments/);
  assert.equal(execute(state,session,"firewall-cmd --query-port=7789/tcp"),"no");
  execute(state,session,"sudo firewall-cmd --permanent --add-port=7789/tcp");
  assert.equal(execute(state,session,"firewall-cmd --query-port=7789/tcp"),"no");
  assert.equal(execute(state,session,"firewall-cmd --permanent --query-port=7789/tcp"),"yes");
  execute(state,session,"sudo firewall-cmd --reload");
  assert.equal(execute(state,session,"firewall-cmd --query-port=7789/tcp"),"yes");
  assert.match(execute(state,session,"firewall-cmd --list-ports"),/7789\/tcp/);
});

test("DRBD split-brain requires victim selection and discard resync sequence",()=>{
  const state=createInitialState(),session=newSession();injectScenario(state,6);execute(state,session,"ssh root@mysql-core01");
  assert.match(execute(state,session,"drbdadm connect r0"),/Need access to UpToDate data/);
  execute(state,session,"drbdadm secondary r0");
  execute(state,session,"drbdadm disconnect r0");
  execute(state,session,"drbdadm --discard-my-data connect r0");
  assert.equal(state.clusters.database.splitBrainStage,3);
  assert.equal(state.clusters.database.drbd,"Connected");
});

test("Elasticsearch restart does not repair disabled shard allocation",()=>{
  const state=createInitialState(),session=newSession();injectScenario(state,16);execute(state,session,"ssh root@elasticsearch01");
  execute(state,session,"systemctl restart elasticsearch");
  assert.equal(state.elastic,"red");
  assert.match(execute(state,session,"curl -s localhost:9200/_cluster/settings?pretty"),/none/);
  execute(state,session,"curl -X PUT localhost:9200/_cluster/settings -d '{\"persistent\":{\"cluster.routing.allocation.enable\":\"all\"}}'");
  assert.equal(state.elastic,"green");
});

test("systemctl rejects units that do not exist on the selected host",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@cassandra01");
  assert.match(execute(state,session,"systemctl start nfs-server"),/could not be found/);
  assert.equal(state.hosts.cassandra01.services["nfs-server"],undefined);
});

test("irrelevant commands cannot auto-complete any exercise",()=>{
  for(const {id} of scenarios){
    const state=createInitialState(),session=newSession();
    injectScenario(state,id);
    execute(state,session,"hostname");
    assert.equal(assessScenario(state,id).passed,false,`exercise ${id} must require relevant evidence`);
  }
});

test("exercise cards expose symptoms without leaking root causes",()=>{
  const publicText=scenarios.map(({title,objective})=>`${title} ${objective}`).join("\n");
  assert.doesNotMatch(publicText,/stale PID|core files|expired TLS|cookie mismatch|invalid listen address|blocked by firewalld|allocation disabled/i);
  assert.match(scenarios.find(({id})=>id===8).explanation,/core file/i);
  assert.match(scenarios.find(({id})=>id===14).explanation,/Erlang cookie/i);
});

test("all seventeen exercises have a working recovery or verification path",()=>{
  const paths={
    1:["ssh root@haproxy01","journalctl -u haproxy","rm /run/haproxy.pid","systemctl start haproxy"],
    2:["ssh root@haproxy01","sed -i '/INVALID/d' /etc/haproxy/haproxy.cfg","systemctl restart haproxy"],
    3:["ssh root@mysql-core02","pcs status","pcs resource cleanup database-group"],
    4:["ssh root@mysql-slave01","mysql","SHOW REPLICA STATUS\\G","SET GLOBAL sql_slave_skip_counter = 1;","START SLAVE;"],
    5:["ssh root@mysql-core01","journalctl -u drbd","firewall-cmd --add-port=7789/tcp --permanent","firewall-cmd --reload","drbdadm connect all"],
    6:["ssh root@mysql-core01","grep -i split-brain /var/log/drbd.log","drbdadm secondary r0","drbdadm disconnect r0","drbdadm --discard-my-data connect r0"],
    7:["ssh root@mysql-core02","pcs status","pcs resource cleanup database-group"],
    8:["ssh root@san01","df -h","rm -f /tmp/core.*"],
    9:["ssh root@san02","pcs status","pcs cluster start san01"],
    10:["ssh root@ftp01","tail /var/log/pureftpd.log","cp /etc/pki/tls/certs/lab-ftp-renewed.pem /etc/pki/tls/certs/lab-ftp.pem","firewall-cmd --add-port=30000-31000/tcp --permanent","firewall-cmd --reload","systemctl start pure-ftpd"],
    13:["ssh root@kvm01","nmcli con show","nmcli con modify bridge-br1 connection.master br1","nmcli con up br1"],
    14:["ssh root@rabbitmq01","journalctl -u rabbitmq-server","cp /etc/rabbitmq/lab.erlang.cookie /var/lib/rabbitmq/.erlang.cookie","systemctl start rabbitmq-server"],
    15:["ssh root@cassandra01","journalctl -u cassandra","sed -i 's/listen_address: 127.0.0.1/listen_address: 10.10.61.21/' /etc/cassandra/cassandra.yaml","systemctl start cassandra"],
    16:["ssh root@elasticsearch01","curl -s localhost:9200/_cluster/health?pretty","curl -X PUT localhost:9200/_cluster/settings -d '{\"persistent\":{\"cluster.routing.allocation.enable\":\"all\"}}'"],
    18:["pcs status"],19:["pcs status"],20:["pcs status"]
  };
  for(const {id} of scenarios){
    const state=createInitialState(),session=newSession();
    injectScenario(state,id);
    paths[id].forEach(command=>execute(state,session,command));
    assert.equal(assessScenario(state,id).passed,true,`exercise ${id} must be completable`);
  }
});

test("NFS failover completes only after san01 rejoins the cluster",()=>{
  const state=createInitialState(),session=newSession();
  injectScenario(state,9);
  assert.equal(state.clusters.storage.owner,"san02");
  assert.equal(state.hosts.san01.online,false);
  execute(state,session,"ssh root@san02");
  execute(state,session,"pcs status");
  assert.equal(assessScenario(state,9).passed,false);
  assert.match(execute(state,session,"pcs cluster start san01"),/successfully rejoined/);
  assert.equal(state.hosts.san01.online,true);
  assert.equal(state.hosts.san01.services["nfs-server"],"inactive (dead)");
  assert.equal(state.hosts.san02.services["nfs-server"],"active (running)");
  assert.equal(state.clusters.storage.owner,"san02");
  assert.equal(assessScenario(state,9).passed,true);
});

test("out-of-band power-on is a valid Exercise 9 recovery path",()=>{
  const state=createInitialState();
  injectScenario(state,9);
  assert.match(setHostPower(state,"san01","start","management"),/started/);
  assert.equal(state.hosts.san01.online,true);
  assert.ok(state.hosts.san01.history.includes("powerctl start san01"));
  assert.equal(state.clusters.storage.owner,"san02");
  assert.equal(assessScenario(state,9).passed,true);
});

test("VM shutdown, start, and reboot update persistent host state",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@kvm01");
  assert.match(execute(state,session,"virsh shutdown web01-vm"),/being shutdown/);
  assert.equal(state.hosts.web01.online,false);
  assert.match(execute(state,session,"virsh list --all"),/web01-vm\s+shut off/);
  assert.match(execute(state,session,"virsh start web01-vm"),/started/);
  assert.equal(state.hosts.web01.online,true);
  assert.match(execute(state,session,"virsh reboot web01-vm"),/rebooted/);
  assert.equal(state.hosts.web01.online,true);
});

test("virsh console enters a running guest by ID or name and returns to the hypervisor",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@kvm01");
  assert.ok(completions("virsh c",state,session).includes("console"));
  assert.match(execute(state,session,"virsh console 1"),/Connected to domain 'web01-vm'/);
  assert.equal(session.host,"web01");
  assert.equal(session.user,"root");
  assert.equal(execute(state,session,"hostname"),"web01");
  assert.match(execute(state,session,"exit"),/Connection to lab node closed/);
  assert.equal(session.host,"kvm01");
  assert.match(execute(state,session,"virsh console web01-vm"),/Escape character is \^\]/);
  assert.equal(session.host,"web01");
});

test("virsh console rejects stopped guests without changing the active terminal",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@kvm01");
  execute(state,session,"virsh shutdown web01-vm");
  assert.match(execute(state,session,"virsh console web01-vm"),/Guest is not running/);
  assert.equal(session.host,"kvm01");
});

test("guest bridge configuration is stateful and brctl reflects the active bridge",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@web01");
  assert.match(execute(state,session,"nmcli con show"),/ens192/);
  assert.doesNotMatch(execute(state,session,"nmcli con show"),/\bbr0\b/);
  assert.equal(execute(state,session,"bridge link show"),"No bridge slave interfaces.");
  assert.match(execute(state,session,"nmcli con add type ethernet slave-type bridge con-name bridge-br0 ifname ens192 master br0"),/master connection 'br0' not found/);
  assert.match(execute(state,session,"nmcli con add type bridge ifname br0 con-name br0"),/successfully added/);
  assert.match(execute(state,session,"nmcli con add type ethernet slave-type bridge con-name bridge-br0 ifname ens192 master br0"),/successfully added/);
  assert.match(execute(state,session,"nmcli con up br0"),/successfully activated/);
  assert.match(execute(state,session,"ip link show"),/br0/);
  assert.match(execute(state,session,"ip a"),/inet 10\.10\.12\.21\/24 scope global br0/);
  assert.match(execute(state,session,"bridge link show"),/eno2|ens192/);
  assert.match(execute(state,session,"brctl show"),/br0[\s\S]*ens192/);
});

test("virsh edit opens and persists a fictional VM XML configuration",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@kvm01");
  const opened=execute(state,session,"virsh edit 1");
  assert.equal(opened.editor.command,"virsh edit");
  assert.equal(opened.editor.path,"/etc/libvirt/qemu/web01-vm.xml");
  assert.match(opened.editor.content,/<name>web01-vm<\/name>/);
  saveEditedFile(state,"kvm01",opened.editor.path,opened.editor.content.replace("<vcpu placement='static'>4</vcpu>","<vcpu placement='static'>6</vcpu>"),"root");
  assert.match(execute(state,session,"virsh edit web01-vm").editor.content,/>6<\/vcpu>/);
});

test("shutdown closes the simulated SSH session and reboot returns online",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@web01");
  assert.match(execute(state,session,"shutdown"),/closed by remote host/);
  assert.equal(session.host,"bastion01");
  assert.equal(state.hosts.web01.online,false);
  execute(state,session,"ssh root@kvm01");
  execute(state,session,"virsh start web01-vm");
  execute(state,session,"exit");
  execute(state,session,"ssh root@web01");
  assert.match(execute(state,session,"reboot"),/closed by remote host/);
  assert.equal(session.host,"bastion01");
  assert.equal(state.hosts.web01.online,true);
});

test("stale terminals cannot execute commands on powered-off guests",()=>{
  const state=createInitialState(),admin=newSession(),stale=newSession(2);
  execute(state,stale,"ssh root@web01");
  execute(state,admin,"ssh root@kvm01");
  execute(state,admin,"virsh shutdown web01-vm");
  assert.match(execute(state,stale,"touch /tmp/should-not-exist"),/virtual machine is not running/);
  assert.equal(stale.host,"bastion01");
  assert.equal(state.hosts.web01.files["/tmp/should-not-exist"],undefined);
});

test("pcs -f resource move migrates database group and VIP to core01",()=>{
  const state=createInitialState(),session=newSession();
  execute(state,session,"ssh root@mysql-core01");
  execute(state,session,"systemctl stop mariadb");
  assert.equal(state.clusters.database.owner,"mysql-core02");
  const moved=execute(state,session,"pcs -f /etc/corosync/corosync.conf resource move database-group mysql-core01");
  assert.match(moved,/successfully moved/);
  assert.equal(state.clusters.database.owner,"mysql-core01");
  assert.equal(state.mysql.primary,"mysql-core01");
  assert.equal(state.clusters.database.roles,"Primary/Secondary");
  assert.match(execute(state,session,"ip a"),/10\.10\.20\.10\/24/);
  execute(state,session,"exit");
  execute(state,session,"ssh root@mysql-core02");
  assert.doesNotMatch(execute(state,session,"ip a"),/10\.10\.20\.10\/24/);
});

test("pcs move accepts --node and supports clearing temporary constraint",()=>{
  const state=createInitialState(),session=newSession();
  const moved=execute(state,session,"pcs resource move database-group mysql-core02 --node mysql-core02");
  assert.match(moved,/mysql-core02/);
  assert.equal(state.clusters.database.owner,"mysql-core02");
  assert.match(execute(state,session,"pcs constraint"),/database-group prefers mysql-core02/);
  assert.match(execute(state,session,"pcs resource clear database-group"),/Removing constraint/);
  assert.match(execute(state,session,"pcs constraint"),/No temporary location constraints/);
});
