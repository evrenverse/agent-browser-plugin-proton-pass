/** Item resolution. Pure functions over an already-fetched item list. */

/**
 * Best-effort registrable domain from a URL.
 *
 * ponytail: naive last-two-labels rule; wrong for multi-part suffixes such as
 * co.uk, which yields "co.uk" instead of "example.co.uk". The label derived
 * from it in matchItems can therefore be a public-suffix fragment (e.g. "co")
 * rather than the real brand. Token matching in matchItems keeps a fragment
 * like that from silently selecting an unrelated item by substring, but a
 * wrong-but-plausible label is still only caught by the single-match rule,
 * not eliminated. Swap in the public suffix list if this ever needs to be
 * exact rather than fuzzy.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function registrableDomain(url) {
  try {
    const { hostname } = new URL(url);
    const labels = hostname.split('.');
    return labels.length <= 2 ? hostname : labels.slice(-2).join('.');
  } catch {
    return null;
  }
}

/**
 * Alphanumeric tokens of an already-lowercased title. Matching a domain label
 * against whole tokens rather than any substring is what keeps a public-suffix
 * fragment from selecting an unrelated item: the label "co", left over from a
 * naive registrableDomain("portal.example.co.uk"), is a substring of
 * "amazon.com" but is not one of its tokens.
 *
 * @param {string} lowercaseTitle
 * @returns {string[]}
 */
function titleTokens(lowercaseTitle) {
  return lowercaseTitle.split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Find exactly one item.
 *
 * Order: exact title, then substring in either direction, then the URL host.
 * Anything other than a single hit returns the candidate titles so the caller can
 * name them. Titles are not secrets.
 *
 * @param {Array<{id: string, share_id: string, title: string, item_type: string}>} items
 * @param {{itemRef?: string, url?: string|null}} query
 * @returns {{matched: object|null, candidates: string[]}}
 */
export function matchItems(items, query) {
  const logins = items.filter((item) => item.item_type === 'login');
  const needle = (query.itemRef ?? '').trim().toLowerCase();

  if (needle) {
    const exact = logins.filter((item) => item.title.toLowerCase() === needle);
    if (exact.length === 1) return { matched: exact[0], candidates: [] };

    const partial = logins.filter((item) => {
      const title = item.title.toLowerCase();
      // The reverse direction (needle contains title) is only trusted for
      // titles of at least 3 characters — a shorter title like "X" would
      // otherwise be a substring of almost any reference and win by accident.
      return title.includes(needle) || (title.length >= 3 && needle.includes(title));
    });
    if (partial.length === 1) return { matched: partial[0], candidates: [] };
    if (partial.length > 1) return { matched: null, candidates: partial.map((item) => item.title) };

    return { matched: null, candidates: logins.map((item) => item.title) };
  }

  const domain = query.url ? registrableDomain(query.url) : null;
  if (domain) {
    const label = domain.split('.')[0];
    const byDomain = logins.filter((item) => {
      const title = item.title.toLowerCase();
      return title.includes(domain) || titleTokens(title).includes(label);
    });
    if (byDomain.length === 1) return { matched: byDomain[0], candidates: [] };
    if (byDomain.length > 1) return { matched: null, candidates: byDomain.map((item) => item.title) };
  }

  return { matched: null, candidates: logins.map((item) => item.title) };
}
