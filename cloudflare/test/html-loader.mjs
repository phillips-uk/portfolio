// Lets node import the Worker's .html modules (wrangler bundles them as text) during tests.
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function load(url, context, next) {
  if (url.endsWith('.html')) return { format: 'module', source: 'export default "<body></body>";', shortCircuit: true };
  return next(url, context);
}`));
