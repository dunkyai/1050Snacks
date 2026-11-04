// Shared network helpers for talking to Instacart through Playwright.
//
// Why this exists: Instacart sits behind CloudFront, which answers 403
// "The request could not be satisfied. Request blocked." to some IPs
// (seen Nov 2026 from the Hetzner box in Helsinki). The scraper used to
// swallow that and return an empty list, so /snacks looked like
// "nothing found". These helpers detect the block and let you route
// traffic through a proxy.

class InstacartBlockedError extends Error {
  constructor(detail) {
    super(`Instacart blocked this server's request (${detail}). Search and ordering won't work until the bot runs from an IP Instacart accepts (set INSTACART_PROXY_URL to a US proxy, or host it in the US).`);
    this.name = 'InstacartBlockedError';
    this.blocked = true;
  }
}

// INSTACART_PROXY_URL, e.g. http://user:pass@us.proxy.example.com:8000
function proxyFromEnv(env = process.env) {
  const raw = (env.INSTACART_PROXY_URL || '').trim();
  if (!raw) return undefined;
  const u = new URL(raw);
  const proxy = { server: `${u.protocol}//${u.host}` };
  if (u.username) proxy.username = decodeURIComponent(u.username);
  if (u.password) proxy.password = decodeURIComponent(u.password);
  return proxy;
}

function launchOptions(args) {
  const opts = { headless: true, args };
  const proxy = proxyFromEnv();
  if (proxy) {
    opts.proxy = proxy;
    console.log(`[net] using proxy ${proxy.server}`);
  }
  return opts;
}

const BLOCK_PATTERNS = [
  /The request could not be satisfied/i,
  /Request blocked/i,
  /Access Denied/i,
  /verify you are (a )?human/i,
  /unusual traffic/i,
];

// Throws InstacartBlockedError when a navigation came back blocked.
// `response` is what page.goto() returned (may be null).
async function assertNotBlocked(page, response, label = 'page') {
  const status = response ? response.status() : null;
  let title = '';
  let snippet = '';
  try {
    title = await page.title();
    snippet = await page.evaluate(() => (document.body?.innerText || '').slice(0, 400));
  } catch { /* page may be mid-navigation */ }

  const text = `${title}\n${snippet}`;
  const looksBlocked = BLOCK_PATTERNS.some(re => re.test(text));
  if (status === 403 || status === 429 || looksBlocked) {
    const detail = `HTTP ${status ?? '?'} on ${label}${title ? `, "${title.slice(0, 80)}"` : ''}`;
    console.error(`[net] BLOCKED: ${detail}`);
    throw new InstacartBlockedError(detail);
  }
  if (status && status >= 400) {
    console.warn(`[net] ${label} answered HTTP ${status}`);
  }
  return status;
}

module.exports = { InstacartBlockedError, proxyFromEnv, launchOptions, assertNotBlocked };
