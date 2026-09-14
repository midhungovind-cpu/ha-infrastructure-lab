export function guidanceForScenario(scenario,kind){
  if(!scenario||!['hint','solution'].includes(kind))return null;
  return {
    title:`${kind==='hint'?'Hint':'Explanation'}: ${scenario.title}`,
    body:kind==='hint'?scenario.hint:scenario.explanation,
    commands:kind==='hint'?[...scenario.commands]:[],
    condition:kind==='solution'?scenario.success:''
  };
}
