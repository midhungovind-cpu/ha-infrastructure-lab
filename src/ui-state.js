import { migrateState } from "./state.js?v=20260914.22";
export function addSnapshot(state,name){
  const label=String(name||'').trim();if(!label)return false;
  const copy=structuredClone(state);copy.snapshots=[];
  state.snapshots.push({name:label.slice(0,100),created:new Date().toISOString(),state:copy});return true;
}
export function restoreSnapshot(state,index,createInitialState){
  const restored=index==='clean'?createInitialState():migrateState(structuredClone(state.snapshots[Number(index)].state));
  restored.snapshots=state.snapshots;return restored;
}
