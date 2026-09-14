export const serviceUp=(host,service)=>Boolean(host?.online&&host.services?.[service]?.startsWith('active'));
export function serviceNodes(state,prefix,dc='primary'){
  return Object.values(state.hosts).filter(host=>host.dc===dc&&new RegExp(`^(dr-)?${prefix}\\d{2}$`).test(host.hostname));
}
export function elasticHealth(state,dc='primary'){
  const nodes=serviceNodes(state,'elasticsearch',dc),running=nodes.filter(host=>serviceUp(host,'elasticsearch'));
  const allocation=dc==='primary'?state.elasticAllocation:(state.recoveryElasticAllocation||'all');
  return {nodes,running,allocation,status:allocation==='none'||running.length<2?'red':running.length===nodes.length?'green':'yellow'};
}
export function refreshHealth(state){
  state.rabbitOnline=serviceNodes(state,'rabbitmq').filter(h=>serviceUp(h,'rabbitmq-server')).length;
  state.cassandraOnline=serviceNodes(state,'cassandra').filter(h=>serviceUp(h,'cassandra')).length;
  state.elastic=elasticHealth(state).status;
  return state;
}
