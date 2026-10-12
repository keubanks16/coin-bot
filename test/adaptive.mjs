import assert from 'node:assert/strict';
import { classifyMarket, adaptiveScore, learnOutcome } from '../src/adaptive.js';
const token={stats1h:{priceChange:8,buyOrganicVolume:200,sellOrganicVolume:100},stats5m:{priceChange:2}};
assert.equal(classifyMarket(token),'scalp');
assert.equal(adaptiveScore(token,10,{}).strategy,'scalp');
const model=learnOutcome({},'scalp',4);
assert.equal(model.scalp.wins,1);
assert.equal(model.scalp.net,4);
assert.equal(learnOutcome(model,'scalp',-2).scalp.losses,1);
console.log('adaptive strategy tests passed');

import { loadConfig, exitDecision } from '../src/strategy.js';
const cfg=loadConfig({});
const p={entry_price:1,peak_price:1,opened_at:Date.now()-2*3600e3};
assert.equal(exitDecision(p,1.07,cfg,Date.now(),'scalp').reason,'take profit');
assert.equal(exitDecision(p,1.07,cfg,Date.now(),'momentum').sell,false);
assert.equal(exitDecision(p,1.01,cfg,Date.now(),'scalp').reason,'max hold time');
