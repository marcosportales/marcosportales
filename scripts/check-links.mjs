import { readFile } from 'node:fs/promises';

const README = new URL('../README.md', import.meta.url);
const TIMEOUT_MS = 25_000;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const markdown = await readFile(README, 'utf8');

const unescape = (url) => url.replaceAll('&amp;', '&');

function collect(regex, kind, into) {
  for (const [, url] of markdown.matchAll(regex)) into.push({ kind, url: unescape(url) });
}

const found = [];
collect(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g, 'image', found);
collect(/<img[^>]*\ssrc="(https:\/\/[^"]+)"/g, 'image', found);
collect(/(?<!!)\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g, 'link', found);
collect(/<a[^>]*\shref="(https:\/\/[^"]+)"/g, 'link', found);

const targets = [
  ...new Map(found.map((t) => [`${t.kind} ${t.url}`, t])).values(),
].sort((a, b) => a.url.localeCompare(b.url));

async function probe(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    });
    const type = res.headers.get('content-type') ?? '';
    await res.body?.cancel();
    return { status: res.status, type };
  } catch (error) {
    return { status: error.name, type: '' };
  }
}

const results = await Promise.all(
  targets.map(async (target) => ({ ...target, ...(await probe(target.url)) })),
);

function verdict({ kind, status, type }) {
  if (typeof status !== 'number') return 'unreachable';
  if (status === 999 || status === 403 || status === 429) return 'blocked';
  if (status < 200 || status >= 300) return 'broken';
  if (kind === 'image' && !type.startsWith('image/')) return 'not-an-image';
  return 'ok';
}

const column = (values) => Math.max(...values.map((v) => v.length));
const hostWidth = column(results.map((r) => new URL(r.url).host));
const kindWidth = column(results.map((r) => r.kind));

for (const result of results) {
  const mark = { ok: 'ok  ', blocked: 'skip', unreachable: 'skip' }[verdict(result)] ?? 'FAIL';
  console.log(
    `${mark}  ${result.kind.padEnd(kindWidth)}  ${new URL(result.url).host.padEnd(hostWidth)}  ${String(result.status).padEnd(3)}  ${result.type.split(';')[0]}`,
  );
}

const failures = results.filter((r) => ['broken', 'not-an-image'].includes(verdict(r)));
const skipped = results.filter((r) => ['blocked', 'unreachable'].includes(verdict(r)));

console.log(
  `\n${results.length - failures.length - skipped.length}/${results.length} verified, ${skipped.length} skipped (host refuses automated requests), ${failures.length} failed`,
);

for (const failure of failures) {
  console.log(`\n${failure.kind} ${verdict(failure)}: ${failure.url}`);
}

process.exitCode = failures.length > 0 ? 1 : 0;
