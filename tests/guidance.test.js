import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from '../src/scenarios.js';
import { guidanceForScenario } from '../src/guidance.js';

test('all 17 hints contain diagnostic guidance without revealing the explanation',()=>{
  for(const scenario of scenarios){
    const hint=guidanceForScenario(scenario,'hint');
    assert.equal(hint.title,`Hint: ${scenario.title}`);
    assert.equal(hint.body,scenario.hint);
    assert.deepEqual(hint.commands,scenario.commands);
    assert.notEqual(hint.commands,scenario.commands);
    assert.equal(hint.condition,'');
    assert.ok(!hint.body.includes('Root cause:'));
  }
});
test('all 17 explanations include the root cause, recovery and resolution condition',()=>{
  for(const scenario of scenarios){
    const explanation=guidanceForScenario(scenario,'solution');
    assert.equal(explanation.title,`Explanation: ${scenario.title}`);
    assert.match(explanation.body,/Root cause:/);
    assert.match(explanation.body,/Expected recovery:/);
    assert.equal(explanation.condition,scenario.success);
    assert.deepEqual(explanation.commands,[]);
  }
});
test('invalid guidance requests are ignored',()=>{
  assert.equal(guidanceForScenario(undefined,'hint'),null);
  assert.equal(guidanceForScenario(scenarios[0],'invalid'),null);
});
