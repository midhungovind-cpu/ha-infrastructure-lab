import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, loadState, saveState } from '../src/state.js';
import { execute, newSession, completions, injectScenario, setHostPower } from '../src/engine.js';
import { addSnapshot, restoreSnapshot } from '../src/ui-state.js';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('every browser module and server script passes a syntax check',()=>{
  for(const directory of ['src','scripts'])for(const file of readdirSync(new URL(`../${directory}/`,import.meta.url)).filter(name=>name.endsWith('.js'))){
    const result=spawnSync(process.execPath,['--check',fileURLToPath(new URL(`../${directory}/${file}`,import.meta.url))],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  }
});

test('all allowlisted command entry points tolerate missing and invalid arguments on six host types',()=>{
  let cases=0;
  for(const host of ['bastion01','kvm01','mysql-core01','san01','ftp01','dr-cassandra01'])
    for(const cmd of completions('',createInitialState()))for(const suffix of ['',' --unsupported-option',' nonexistent']){
      const state=createInitialState(),s=newSession();s.host=host;
      assert.doesNotThrow(()=>execute(state,s,cmd+suffix),`${host}: ${cmd+suffix}`);cases++;
    }
  assert.ok(cases>=1600);
});
test('all 54 node IPs are unique and recovery subnets mirror primary',()=>{
  const state=createInitialState(),hosts=Object.values(state.hosts);
  assert.equal(hosts.length,54);assert.equal(new Set(hosts.map(h=>h.ip)).size,54);
  for(const h of hosts.filter(h=>h.dc==='recovery'))assert.equal(h.ip,state.hosts[h.hostname.slice(3)].ip.replace('10.10.','10.20.'));
});
test('web03 actually runs Lighttpd, and a read replica has no DRBD block device',()=>{
  const state=createInitialState(),s=newSession();s.host='web03';
  assert.match(execute(state,s,'systemctl status lighttpd'),/active/);
  assert.match(execute(state,s,'systemctl status nginx'),/could not be found/);
  s.host='mysql-slave01';assert.doesNotMatch(execute(state,s,'df -h'),/drbd0/);
});
test('valid baseline FTP certificates can restart without an incident',()=>{
  const state=createInitialState(),s=newSession();s.host='ftp01';
  assert.equal(execute(state,s,'systemctl restart pure-ftpd'),'');
  injectScenario(state,10);assert.match(execute(state,s,'systemctl restart pure-ftpd'),/expired/);
});
test('failed distributed members are reflected in membership and health output',()=>{
  const state=createInitialState(),s=newSession();s.host='cassandra01';execute(state,s,'systemctl stop cassandra');
  assert.equal(state.cassandraOnline,2);s.host='cassandra02';assert.match(execute(state,s,'nodetool status'),/DN  10\.10\.61\.21/);
  s.host='rabbitmq01';execute(state,s,'systemctl stop rabbitmq-server');assert.equal(state.rabbitOnline,2);
  s.host='rabbitmq02';assert.match(execute(state,s,'rabbitmqctl cluster_status'),/Running Nodes: 2/);
  s.host='elasticsearch01';execute(state,s,'systemctl stop elasticsearch');assert.equal(state.elastic,'yellow');
  s.host='elasticsearch02';const health=JSON.parse(execute(state,s,'curl localhost:9200/_cluster/health'));
  assert.equal(health.number_of_nodes,2);assert.equal(health.status,'yellow');
  setHostPower(state,'elasticsearch03','shutdown');assert.equal(state.elastic,'red');
});
test('Elasticsearch and membership diagnostics on recovery nodes do not modify primary state',()=>{
  const state=createInitialState(),s=newSession();injectScenario(state,16);s.host='dr-elasticsearch01';
  const health=JSON.parse(execute(state,s,'curl localhost:9200/_cluster/health'));assert.equal(health.status,'green');
  assert.match(execute(state,s,'curl localhost:9200/_cat/nodes'),/10\.20\.62\.21/);
  execute(state,s,`curl -X PUT localhost:9200/_cluster/settings -d '{"persistent":{"cluster.routing.allocation.enable":"all"}}'`);
  assert.equal(state.elasticAllocation,'none');assert.equal(state.elastic,'red');
});
test('unknown hosts and unavailable HTTP services never return fabricated success',()=>{
  const state=createInitialState(),s=newSession();
  assert.match(execute(state,s,'ping invented-host'),/not known/);
  assert.match(execute(state,s,'dig invented-host'),/NXDOMAIN/);
  assert.match(execute(state,s,'curl http://invented-host'),/Could not resolve/);
  s.host='web01';execute(state,s,'systemctl stop nginx');
  assert.match(execute(state,s,'curl http://web01'),/connection refused/);
  assert.match(execute(state,s,'curl http://web02/health'),/200 OK/);
  setHostPower(state,'web02','shutdown');setHostPower(state,'web03','shutdown');
  assert.match(execute(state,s,'curl http://app.lab.internal'),/503/);
});
test('VIP aliases and DRBD roles follow failover in both directions',()=>{
  const state=createInitialState(),s=newSession();s.host='mysql-core01';execute(state,s,'systemctl stop mariadb');
  const client=newSession();execute(state,client,'ssh root@db-vip');assert.equal(client.host,'mysql-core02');
  execute(state,client,'systemctl stop mariadb');assert.equal(state.clusters.database.owner,'mysql-core01');
  assert.equal(state.clusters.database.roles,'Primary/Secondary');
});
test('non-in-place sed is read-only and find honors paths, patterns and depth',()=>{
  const state=createInitialState(),s=newSession(),host=state.hosts.bastion01;
  host.files['/tmp/sample']='alpha alpha\n';
  assert.equal(execute(state,s,"sed 's/alpha/beta/' /tmp/sample"),'beta alpha\n');
  assert.equal(host.files['/tmp/sample'],'alpha alpha\n');
  execute(state,s,"sed -i 's/alpha/beta/g' /tmp/sample");assert.equal(host.files['/tmp/sample'],'beta beta\n');
  assert.match(execute(state,s,'find /tmp'),/\/tmp\/sample/);
  assert.equal(execute(state,s,"find /tmp -name 'sam*'"),'/tmp/sample');
  execute(state,s,'mkdir -p /tmp/sample-dir/deep');execute(state,s,'rm -r /tmp/sample-*');
  assert.doesNotMatch(execute(state,s,'find /tmp'),/sample-dir/);
});
test('moving a file to itself cannot delete it and root cd selects /root',()=>{
  const state=createInitialState(),s=newSession();s.user='root';execute(state,s,'cd');assert.equal(s.cwd,'/root');
  execute(state,s,'touch /tmp/a');assert.match(execute(state,s,'mv /tmp/a /tmp/a'),/same file/);
  assert.ok('/tmp/a' in state.hosts.bastion01.files);
});
test('systemctl enable and disable persist independently of service state',()=>{
  const state=createInitialState(),s=newSession();s.host='web01';execute(state,s,'systemctl disable nginx');
  assert.equal(execute(state,s,'systemctl is-enabled nginx'),'disabled');
  assert.match(execute(state,s,'systemctl status nginx'),/; disabled;/);
  assert.equal(execute(state,s,'systemctl is-active nginx'),'active');
  execute(state,s,'systemctl enable nginx');assert.equal(execute(state,s,'systemctl is-enabled nginx'),'enabled');
});
test('invalid skip counters and wrong-host firewall repairs cannot clear incidents',()=>{
  const state=createInitialState(),s=newSession();injectScenario(state,4);s.host='mysql-slave01';
  assert.match(execute(state,s,'mysql -e "SET GLOBAL sql_slave_skip_counter = 0;"'),/ERROR/);
  assert.equal(state.mysql.skipCounterReady,false);
  injectScenario(state,5);s.host='web01';execute(state,s,'firewall-cmd --add-port=7789/tcp --permanent');execute(state,s,'firewall-cmd --reload');
  assert.equal(state.clusters.database.drbdPortBlocked,true);
  assert.match(execute(state,s,'firewall-cmd --not-a-real-option'),/unsupported/);
});
test('snapshots are independent copies and clean restore retains the snapshot library',()=>{
  const state=createInitialState();assert.equal(addSnapshot(state,'   '),false);
  addSnapshot(state,' Before fault ');state.hosts.san01.disk=98;
  const restored=restoreSnapshot(state,0,createInitialState);assert.equal(restored.hosts.san01.disk,61);
  restored.hosts.san01.disk=70;assert.equal(state.snapshots[0].state.hosts.san01.disk,61);
  assert.equal(restoreSnapshot(state,'clean',createInitialState).snapshots.length,1);
});
test('storage quota failure is reported without crashing the application',()=>{
  const prior=globalThis.localStorage;
  try{globalThis.localStorage={setItem(){throw Error('quota');}};assert.equal(saveState(createInitialState()),false);}
  finally{if(prior===undefined)delete globalThis.localStorage;else globalThis.localStorage=prior;}
});
test('legacy recovery addressing migrates without dropping files or progress',()=>{
  const state=createInitialState();delete state.layoutVersion;const host=state.hosts['dr-cassandra01'];
  host.ip='10.20.10.21';host.interfaces[1].ip='10.20.10.21/24';host.files['/tmp/keep']='saved';
  host.files['/etc/cassandra/cassandra.yaml']=host.files['/etc/cassandra/cassandra.yaml'].replace('10.20.61.21','10.20.10.21');
  const prior=globalThis.localStorage;
  try{globalThis.localStorage={getItem:()=>JSON.stringify(state)};const restored=loadState();assert.equal(restored.hosts['dr-cassandra01'].ip,'10.20.61.21');assert.equal(restored.hosts['dr-cassandra01'].files['/tmp/keep'],'saved');}
  finally{if(prior===undefined)delete globalThis.localStorage;else globalThis.localStorage=prior;}
});

test('reload does not resurrect deleted virtual config files',()=>{
  const state=createInitialState();delete state.hosts.haproxy01.files['/etc/haproxy/haproxy.cfg'];
  const prior=globalThis.localStorage;
  try{globalThis.localStorage={getItem:()=>JSON.stringify(state)};assert.equal(loadState().hosts.haproxy01.files['/etc/haproxy/haproxy.cfg'],undefined);}
  finally{if(prior===undefined)delete globalThis.localStorage;else globalThis.localStorage=prior;}
});

test('private bridge activation does not steal the hypervisor default route',()=>{
  const state=createInitialState(),s=newSession();s.host='kvm01';const before=execute(state,s,'ip route');
  injectScenario(state,13);execute(state,s,'nmcli con modify bridge-br1 connection.master br1');execute(state,s,'nmcli con up br1');
  assert.equal(execute(state,s,'ip route'),before);
  assert.match(execute(state,s,'ip a'),/br0/);
});

test('prototype-like hostnames and services cannot become executable host state',()=>{
  const state=createInitialState(),s=newSession();
  for(const name of ['__proto__','constructor','toString']){
    assert.match(execute(state,s,`ssh root@${name}`),/Could not resolve/);assert.equal(s.host,'bastion01');
    assert.match(execute(state,s,`systemctl start ${name}`),/could not be found/);
  }
});

test('filter flags return correct counts and line numbers or an explicit unsupported error',()=>{
  const state=createInitialState(),s=newSession();
  assert.match(execute(state,s,'cat /etc/hosts | grep -n db-vip'),/^3:/);
  assert.equal(execute(state,s,'cat /etc/hosts | grep -c db-vip'),'1');
  assert.match(execute(state,s,'cat /etc/hosts | grep --invented localhost'),/unsupported option/);
  assert.match(execute(state,s,'cat /etc/hosts | head -n invalid'),/invalid line count/);
  s.host='mysql-core01';execute(state,s,'systemctl stop mariadb | grep --invented x');
  assert.equal(state.clusters.database.owner,'mysql-core01');
});

test('missing HAProxy config cannot start and non-DRBD hosts cannot claim replication health',()=>{
  const state=createInitialState(),s=newSession();s.host='haproxy01';execute(state,s,'rm /etc/haproxy/haproxy.cfg');
  assert.match(execute(state,s,'systemctl restart haproxy'),/configuration file is missing/);
  s.host='web01';assert.match(execute(state,s,'drbdadm status'),/no local block-replication resource/);
});
