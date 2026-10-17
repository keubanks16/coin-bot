// Learning for the pump.fun sniper.
//
// Every coin the bot seriously considers becomes a lesson: either a real paper trade, or a
// "shadow trade" it follows without spending money (when it's full, out of cash, or the model
// says skip). Each finished lesson records the coin's setup (age, buying speed, market cap...)
// and how it really turned out, after fees.
//
// For each setup feature the model keeps a running average return per bucket (e.g. "coins
// 10-20s old": 24 lessons, average −18%). To judge a new coin it starts from the overall average
// and adds how much better or worse each of the coin's buckets has done. Small buckets are
// pulled toward the overall average, so a couple of lucky trades can't fool it.
// Once it has LEARN_MIN_LESSONS lessons it only buys coins whose expected return is above
// LEARN_MIN_EDGE_PCT. Skipped coins keep being followed as shadows, so it can change its mind.

export const FEATURES = {
  age: { label: 'age', unit: 's', edges: [20, 45, 90] },
  inflow: { label: 'SOL bought', unit: ' SOL', edges: [5, 8, 12] },
  speed: { label: 'buying speed', unit: ' SOL/min', edges: [5, 10, 20] },
  mcap: { label: 'market cap', unit: ' SOL', edges: [40, 55, 70] },
  rise: { label: '4s climb', unit: '%', edges: [3, 8, 15] },
  dev: { label: 'creator bag', unit: '%', edges: [2, 5] },
  socials: { label: 'social links', unit: '', edges: [2, 3] },
  hour: { label: 'hour (UTC)', unit: 'h', edges: [6, 12, 18] },
};

const SHRINK = 15; // a bucket needs about this many lessons before its own average dominates
const DAMPEN = 0.5; // features overlap, so only add half of each bucket's effect

export function bucketOf(name, value) {
  const { edges } = FEATURES[name];
  let i = 0;
  while (i < edges.length && value >= edges[i]) i++;
  return i;
}

export function bucketLabel(name, b) {
  const { label, unit, edges } = FEATURES[name];
  if (b === 0) return `${label} under ${edges[0]}${unit}`;
  if (b === edges.length) return `${label} ${edges[edges.length - 1]}${unit}+`;
  return `${label} ${edges[b - 1]}–${edges[b]}${unit}`;
}

/** Setup features for a candidate coin. */
export function featuresOf({ age, inflow, mcap, rise, devPct, socials, now }) {
  return {
    age,
    inflow,
    speed: (inflow / Math.max(age, 5)) * 60,
    mcap,
    rise,
    dev: devPct,
    socials,
    hour: new Date(now).getUTCHours(),
  };
}

export function emptyModel() {
  return { n: 0, real: 0, shadow: 0, sum: 0, wins: 0, b: {} };
}

/** Add one finished lesson. `ret` is the fractional return after fees (−0.3 = −30%). */
export function learn(model, feats, ret, kind = 'shadow') {
  const m = model && model.b ? model : emptyModel();
  const r = Math.max(-1, Math.min(ret, 1)); // cap at +100% so a rare moonshot can't dominate the averages
  m.n++;
  m[kind === 'real' ? 'real' : 'shadow']++;
  m.sum += r;
  if (ret > 0) m.wins++;
  for (const name of Object.keys(FEATURES)) {
    if (feats[name] === undefined || feats[name] === null) continue;
    const key = `${name}:${bucketOf(name, feats[name])}`;
    const s = (m.b[key] ||= { n: 0, sum: 0, wins: 0 });
    s.n++;
    s.sum += r;
    if (ret > 0) s.wins++;
  }
  return m;
}

const shrunk = (s, mean) => (s.sum + SHRINK * mean) / (s.n + SHRINK);

/** Expected return for a setup, and the strongest reasons for it. */
export function predict(model, feats) {
  if (!model || !model.n) return { expected: null, reasons: [] };
  const mean = model.sum / model.n;
  let expected = mean;
  const reasons = [];
  for (const name of Object.keys(FEATURES)) {
    if (feats[name] === undefined || feats[name] === null) continue;
    const b = bucketOf(name, feats[name]);
    const s = model.b[`${name}:${b}`];
    if (!s) continue;
    const effect = (shrunk(s, mean) - mean) * DAMPEN;
    expected += effect;
    reasons.push({ label: bucketLabel(name, b), effect, n: s.n });
  }
  reasons.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  return { expected, reasons };
}

/** Plain-language summary for the dashboard: best and worst setups seen so far. */
export function summarize(model, minN = 5) {
  if (!model || !model.n) return { lessons: 0 };
  const mean = model.sum / model.n;
  const rows = Object.entries(model.b)
    .filter(([, s]) => s.n >= minN)
    .map(([key, s]) => {
      const [name, b] = key.split(':');
      return { label: bucketLabel(name, Number(b)), n: s.n, avg: s.sum / s.n, winRate: s.wins / s.n, score: shrunk(s, mean) };
    })
    .sort((a, b) => b.score - a.score);
  return {
    lessons: model.n,
    real: model.real,
    shadow: model.shadow,
    avg: mean,
    winRate: model.wins / model.n,
    best: rows.slice(0, 3).filter((r) => r.score > mean),
    worst: rows.slice(-3).reverse().filter((r) => r.score < mean),
  };
}
