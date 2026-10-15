// V2 adaptive strategy selector. Lightweight online learning, not a pretrained AI model.
// Only uses outcomes of completed paper trades. Bayesian shrinkage prevents early overconfidence.
export function classifyMarket(t) {
  const h=t.stats1h||{}, m=t.stats5m||{};
  const hour=Number(h.priceChange||0), five=Number(m.priceChange||0);
  const buy=Number(h.buyOrganicVolume||0), sell=Number(h.sellOrganicVolume||0);
  const ratio=buy/Math.max(sell,1);
  if (five>=0.8 && five<=3.5 && hour>=3 && hour<=14 && ratio>=1.2) return 'scalp';
  if (hour>=5 && hour<=25 && five>=0 && five<=6 && ratio>=1.15) return 'momentum';
  return null;
}
export function adaptiveScore(token, baseline, model={}) {
  const strategy=classifyMarket(token);
  if (!strategy || baseline===null || !Number.isFinite(baseline)) return null;
  const s=model[strategy]||{wins:0,losses:0,net:0};
  const n=(s.wins||0)+(s.losses||0);
  // Beta(2,2) prior; small sample sizes remain close to neutral.
  const winRate=((s.wins||0)+2)/(n+4);
  const factor=Math.max(0.6,Math.min(1.4,0.8+winRate*0.4+Math.tanh((s.net||0)/100)*0.2));
  return {strategy,score:baseline*factor,confidence:winRate,samples:n};
}
export function learnOutcome(model={}, strategy, pnl) {
  if (!['scalp','momentum'].includes(strategy) || !Number.isFinite(pnl)) return model;
  const next={...model};
  const old=next[strategy]||{wins:0,losses:0,net:0};
  next[strategy]={wins:old.wins+(pnl>0?1:0),losses:old.losses+(pnl<=0?1:0),net:old.net+pnl};
  return next;
}
/** Score multiplier (0.6–1.4) from a strategy's completed-trade record; 1 when there's no history. */
export function adaptiveFactor(model={}, strategy) {
  const s=model[strategy];
  if (!s) return 1;
  const n=(s.wins||0)+(s.losses||0);
  const winRate=((s.wins||0)+2)/(n+4);
  return Math.max(0.6,Math.min(1.4,0.8+winRate*0.4+Math.tanh((s.net||0)/100)*0.2));
}
