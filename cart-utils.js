// Pure helpers for turning bot cart rows into an Instacart order and checking
// the real Instacart cart against what the bot expects. No browser/DB here so
// test.js can exercise them directly.

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// First clause of a product name (before the first comma), normalized.
function coreName(name) {
  return normalizeName(String(name || '').split(',')[0]);
}

// Loose "same product?" check between a name we stored and a name Instacart shows.
// Instacart titles can be truncated or re-ordered, so compare on the core tokens.
function namesMatch(expected, actual) {
  return matchScore(expected, actual) > 0;
}

// 3 = identical, 2 = one contains the other, 1 = core tokens overlap, 0 = no match
function matchScore(expected, actual) {
  const a = normalizeName(expected);
  const b = normalizeName(actual);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (a.includes(b) || b.includes(a)) return 2;
  const core = coreName(expected).split(' ').filter(t => t.length > 1);
  if (!core.length) return 0;
  const actualTokens = new Set(b.split(' '));
  const hits = core.filter(t => actualTokens.has(t)).length;
  return hits / core.length >= 0.8 ? 1 : 0;
}

// Collapse duplicate cart rows (e.g. 15 clicks on the same product) into one
// entry with a quantity, so the orderer adds the product once and sets qty.
function groupCartItems(items) {
  const groups = new Map();
  for (const item of items) {
    // Key on the name, not the URL: rows for one product may or may not carry a URL
    // (e.g. a SwitchBot press vs a Slack add), and they must become one line item.
    const key = `${item.store}|${normalizeName(item.name)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        name: item.name,
        productUrl: item.product_url || null,
        price: item.price,
        qty: 0,
        ids: [],
      });
    }
    const g = groups.get(key);
    if (!g.productUrl && item.product_url) g.productUrl = item.product_url;
    g.qty += 1;
    g.ids.push(item.id);
  }
  return [...groups.values()];
}

// Compare expected groups ({name, qty}) with lines read from the Instacart cart
// ({name, qty|null}). qty null means the page didn't expose a quantity.
function reconcileCart(groups, cartLines) {
  const usedLines = new Set();
  const matched = [];
  const missing = [];
  for (const group of groups) {
    // Prefer the closest-named line so similar products (e.g. two sizes) don't swap
    let idx = -1;
    let best = 0;
    cartLines.forEach((line, i) => {
      if (usedLines.has(i)) return;
      const score = matchScore(group.name, line.name);
      if (score > best) { best = score; idx = i; }
    });
    if (idx === -1) { missing.push(group); continue; }
    usedLines.add(idx);
    matched.push({ group, line: cartLines[idx] });
  }
  const unexpected = cartLines.filter((_, i) => !usedLines.has(i));
  const qtyMismatch = matched.filter(m => m.line.qty != null && m.line.qty !== m.group.qty);
  return { matched, missing, unexpected, qtyMismatch };
}

function isCartClean(result) {
  return !result.missing.length && !result.unexpected.length && !result.qtyMismatch.length;
}

function describeMismatch(result) {
  const lines = [];
  for (const g of result.missing) lines.push(`• Missing from Instacart: ${g.qty}× ${g.name}`);
  for (const l of result.unexpected) lines.push(`• In Instacart but not in Munchy's cart: ${l.qty ?? '?'}× ${l.name}`);
  for (const m of result.qtyMismatch) lines.push(`• Wrong quantity: ${m.group.name} — expected ${m.group.qty}, Instacart has ${m.line.qty}`);
  return lines.join('\n');
}

module.exports = { normalizeName, coreName, namesMatch, matchScore, groupCartItems, reconcileCart, isCartClean, describeMismatch };
