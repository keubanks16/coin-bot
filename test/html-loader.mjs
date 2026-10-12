// Lets Node import .html files as text, the same way wrangler's Text rule does.
import { readFile } from 'node:fs/promises';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.html')) {
    const text = await readFile(new URL(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(text)};` };
  }
  return nextLoad(url, context);
}
