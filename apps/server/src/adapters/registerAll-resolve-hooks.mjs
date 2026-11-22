import { appendFileSync } from 'node:fs';

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const log = process.env.TIERWYN_RESOLVE_LOG;
  if (log && typeof result.url === 'string') {
    appendFileSync(log, `${result.url}\n`);
  }
  return result;
}
