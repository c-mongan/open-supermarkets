/**
 * Mr Price Ireland — Shopify search.
 *
 * Protocol credit: but3k4/supermarket-mcp (MIT).
 */
import type { GroceryProvider, Product, SearchOptions } from './types';
import {
  absoluteUrl,
  asRecord,
  clampLimit,
  clampOffset,
  firstString,
  type FetchLike,
  jsonResponse,
  ProviderHttpError,
  ProviderInputError,
  ProviderProtocolError,
  requireRecordArray,
  requireQuery,
  responseText,
} from './ie/shared';

function decodeEntities(value: string): string {
  return value.replace(/&(amp|quot|apos|nbsp|lt|gt|#x[0-9a-f]+|#[0-9]+);/gi, (entity, value: string) => {
    const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", nbsp: ' ', lt: '<', gt: '>' };
    const token = value.toLowerCase();
    if (named[token] !== undefined) return named[token];
    const point = token.startsWith('#x') ? parseInt(token.slice(2), 16) : Number(token.slice(1));
    return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  });
}

function htmlText(value: string): string {
  return decodeEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}


const BASE_URL = 'https://www.mrprice.online';

export interface MrPriceIrelandOptions {
  fetcher?: FetchLike;
  baseUrl?: string;
}

function shopifyMoney(value: unknown, cents = false): number | undefined {
  if (cents && typeof value === 'string' && !/^\d+$/.test(value.trim())) return undefined;
  let parsed: number | undefined;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string' && /^\d+(?:[.,]\d+)?$/.test(value.trim())) {
    parsed = Number(value.trim().replace(',', '.'));
  }
  if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) return undefined;
  // Predictive search uses major currency units. HTML data-price uses cents.
  if (cents) return Number.isInteger(parsed) ? parsed / 100 : undefined;
  return parsed;
}

function canonicalProductUrl(baseUrl: string, value: unknown): string | undefined {
  const absolute = absoluteUrl(baseUrl, value);
  if (!absolute) return undefined;
  const url = new URL(absolute);
  if (url.origin !== new URL(baseUrl).origin || url.username || url.password) return undefined;
  const product = url.pathname.match(/\/products\/([^/]+)\/?$/);
  if (!product) return undefined;
  url.pathname = `/products/${product[1]}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function mapPredictiveProduct(
  item: Record<string, unknown>,
  baseUrl: string
): Product | undefined {
  const name = firstString(item.title, item.name);
  const url = canonicalProductUrl(baseUrl, firstString(item.url));
  const price = shopifyMoney(item.price);
  if (!name || !url || price === undefined) return undefined;
  const soldOut = Array.isArray(item.tags) && item.tags.some(tag =>
    typeof tag === 'string' && /^(?:out of stock|sold out)$/i.test(tag));
  let inStock: boolean | null = null;
  if (soldOut && item.available !== true) inStock = false;
  else if (!soldOut && typeof item.available === 'boolean') inStock = item.available;
  return {
    product_uid: url,
    name,
    retail_price: { price },
    in_stock: inStock,
    size: name.match(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|pack)(?:\b|$)/i)?.[0],
    image_url: absoluteUrl(
      baseUrl,
      firstString(asRecord(item.featured_image).url, item.image)
    ),
    provider: 'mrprice-ie',
    currency: 'EUR',
  };
}

function extractAttribute(tag: string, attribute: string): string | undefined {
  for (const match of tag.matchAll(/(?:^|\s)([^\s"'=<>`]+)\s*=\s*(["'])(.*?)\2/g)) {
    if (match[1]!.toLowerCase() === attribute.toLowerCase()) return match[3];
  }
  return undefined;
}

function hasClass(tag: string, name: string): boolean {
  return (extractAttribute(tag, 'class') ?? '').split(/\s+/).includes(name);
}

function mapHtmlCard(card: string, baseUrl: string): Product | undefined {
  const anchors = [...card.matchAll(/<a\b[^>]*>/gi)]
    .filter(match => canonicalProductUrl(baseUrl, extractAttribute(match[0], 'href')));
  const named = anchors.map(match => {
    const start = match.index! + match[0].length;
    const close = card.toLowerCase().indexOf('</a>', start);
    const title = extractAttribute(match[0], 'title');
    const name = (title ? htmlText(title) : '') ||
      (close >= 0 ? htmlText(card.slice(start, close)) : '');
    return { match, name };
  }).find(row => row.name);
  if (!named) return undefined;
  const url = canonicalProductUrl(baseUrl, extractAttribute(named.match[0], 'href'))!;
  const name = named.name;

  const openTag = [...card.matchAll(/<[^>]+>/g)].find(match => hasClass(match[0], 'product-card'))?.[0] ?? '';
  const cents = extractAttribute(openTag, 'data-price');
  const price = shopifyMoney(cents, true);
  if (price === undefined) return undefined;
  const imageTag = card.match(/<img\b[^>]*>/i)?.[0];
  const image = imageTag
    ? absoluteUrl(
        baseUrl,
        extractAttribute(imageTag, 'data-src')
          ?.replace('{width}', '400')
          .replace(/^\/\//, 'https://') ?? extractAttribute(imageTag, 'src')
      )
    : undefined;
  const soldOut = /(?:^|\s)(?:sold-out|out-of-stock|unavailable)(?:\s|$)/i.test(
    extractAttribute(openTag, 'class') ?? ''
  );

  return {
    product_uid: url,
    name,
    size: name.match(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|ml|l|pack)(?:\b|$)/i)?.[0],
    retail_price: { price },
    in_stock: soldOut ? false : null,
    image_url: image,
    provider: 'mrprice-ie',
    currency: 'EUR',
  };
}

function extractSearchGrid(html: string): string {
  const marker = [...html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)]
    .find(match => extractAttribute(match[0], 'id') === 'js-product-ajax');
  if (!marker || marker.index === undefined) {
    throw new ProviderProtocolError(
      'Mr Price Ireland',
      'HTML response did not contain the search results grid'
    );
  }

  return elementContent(html, marker, 'search results grid');
}

function elementContent(html: string, marker: RegExpMatchArray, label: string): string {
  if (marker.index === undefined) throw new ProviderProtocolError('Mr Price Ireland', `missing ${label}`);
  const tagName = marker[1]!;
  const contentStart = marker.index + marker[0].length;
  const tags = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tags.lastIndex = contentStart;
  let depth = 1;
  for (const match of html.matchAll(tags)) {
    const tag = match[0];
    if (tag.startsWith('</')) {
      depth -= 1;
    } else if (!/\/\s*>$/.test(tag)) {
      depth += 1;
    }
    if (depth === 0) {
      return html.slice(contentStart, match.index);
    }
  }

  throw new ProviderProtocolError(
    'Mr Price Ireland',
    `HTML ${label} was not closed`
  );
}

function visibleSearchHtml(html: string): string {
  html = html.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');
  for (const marker of [...html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)].reverse()) {
    const tag = marker[0];
    const style = extractAttribute(tag, 'style') ?? '';
    if (!/\shidden(?:\s|=|>)/i.test(tag) && extractAttribute(tag, 'aria-hidden') !== 'true' &&
      !/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) continue;
    if (/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(marker[1]!)) continue;
    const content = elementContent(html, marker, 'hidden element');
    const afterContent = marker.index! + tag.length + content.length;
    const close = html.slice(afterContent).match(/^<\/[a-z][\w:-]*\s*>/i)![0];
    html = html.slice(0, marker.index) + html.slice(afterContent + close.length);
  }
  return html;
}

function hasNoResultsMessage(html: string, query: string): boolean {
  const main = [...html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)]
    .find(match => extractAttribute(match[0], 'id') === 'MainContent');
  if (!main) return false;
  const content = elementContent(html, main, 'main search content');
  const form = [...content.matchAll(/<(form)\b[^>]*>/gi)]
    .find(match => hasClass(match[0], 'search-form') && extractAttribute(match[0], 'action') === '/search');
  if (!form) return false;
  const formContent = elementContent(content, form, 'search form');
  const queryInput = [...formContent.matchAll(/<input\b[^>]*>/gi)]
    .find(match => extractAttribute(match[0], 'name') === 'q');
  if (!queryInput || decodeEntities(extractAttribute(queryInput[0], 'value') ?? '') !== query) return false;
  return [...content.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)]
    .filter(match => hasClass(match[0], 'collection-nomatch-text'))
    .some(marker => htmlText(elementContent(content, marker, 'no-results message')) === 'No results found');
}

function parseHtmlProducts(
  html: string,
  baseUrl: string,
  limit: number,
  offset: number,
  query: string
): Product[] {
  html = visibleSearchHtml(html);
  let grid: string;
  try {
    grid = extractSearchGrid(html);
  } catch (error) {
    if (error instanceof ProviderProtocolError && error.message.includes('did not contain the search results grid') && hasNoResultsMessage(html, query)) return [];
    throw error;
  }
  const starts = [...grid.matchAll(/<[^>]+>/g)]
    .filter(match => hasClass(match[0], 'product-card'))
    .map(match => match.index!);
  if (starts.length === 0) {
    if (hasNoResultsMessage(html, query)) return [];
    throw new ProviderProtocolError('Mr Price Ireland', 'HTML grid contained no recognized products or genuine no-results message');
  }
  const cards = starts.map((start, index) =>
    grid.slice(start, starts[index + 1] ?? grid.length)
  );
  const products = cards
    .map((card) => mapHtmlCard(card, baseUrl))
    .filter((product): product is Product => product !== undefined);
  if (cards.length > 0 && products.length === 0) {
    throw new ProviderProtocolError(
      'Mr Price Ireland',
      'HTML product-card collection contained no valid products'
    );
  }
  const pagerHtml = [...html.matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)]
    .filter(match => hasClass(match[0], 'AjaxinatePagination'))
    .map(marker => elementContent(html, marker, 'pagination control'))
    .join('\n');
  const hasNextPage = [...pagerHtml.matchAll(/<a\b[^>]*>/gi)].some(match => {
    const href = extractAttribute(match[0], 'href');
    if (!href) return false;
    try {
      const link = new URL(href.replace(/&amp;|&#0*38;|&#x0*26;/gi, '&'), new URL('/search', baseUrl));
      const page = link.searchParams.get('page');
      return link.pathname === '/search' && link.searchParams.get('q') === query &&
        page !== null && /^\d+$/.test(page) && Number(page) > 1;
    } catch {
      return false;
    }
  });
  if (hasNextPage && offset + limit > products.length) {
    throw new ProviderInputError('Mr Price Ireland', 'requested window exceeds the first HTML search page; further pages are unsupported');
  }
  return products.slice(offset, offset + limit);
}

function objectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderProtocolError('Mr Price Ireland', `missing or malformed ${path}`);
  }
  return value as Record<string, unknown>;
}

function predictiveProducts(payload: unknown, baseUrl: string): Product[] {
  const root = objectRecord(payload, 'predictive response');
  const resources = objectRecord(root.resources, 'resources branch');
  const results = objectRecord(resources.results, 'results branch');
  const source = results.products;
  const rows = requireRecordArray(source, 'Mr Price Ireland', 'products collection');

  const products = rows
    .map((item) => mapPredictiveProduct(item, baseUrl))
    .filter((product): product is Product => product !== undefined);
  if (Array.isArray(source) && source.length > 0 && products.length === 0) {
    throw new ProviderProtocolError(
      'Mr Price Ireland',
      'products collection contained no valid products'
    );
  }
  return products;
}

export class MrPriceIrelandProvider implements GroceryProvider {
  readonly name = 'mrprice-ie';
  private readonly fetcher: FetchLike;
  private readonly baseUrl: string;

  constructor(options: MrPriceIrelandOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = options.baseUrl ?? BASE_URL;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    if (options.category) throw new ProviderInputError('Mr Price Ireland', 'category filtering is unsupported');
    const normalizedQuery = requireQuery(query);
    const limit = clampLimit(options.limit, 10, 20);
    const offset = clampOffset(options.offset);
    if (offset !== 0) {
      throw new ProviderInputError('Mr Price Ireland', 'pagination is unsupported; offset must be zero');
    }
    const predictiveLimit = Math.min(offset + limit, 10);

    const suggestionUrl = new URL('/search/suggest.json', this.baseUrl);
    suggestionUrl.searchParams.set('q', normalizedQuery);
    suggestionUrl.searchParams.set('resources[type]', 'product');
    suggestionUrl.searchParams.set('resources[limit]', String(predictiveLimit));

    const suggestionResponse = await this.fetcher(suggestionUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });

    if (suggestionResponse.ok) {
      const payload = await jsonResponse<unknown>(suggestionResponse, 'Mr Price Ireland');
      const predictive = predictiveProducts(payload, this.baseUrl);
      const predictiveWindowFitsCap = offset <= 10 - limit;
      if (predictive.length >= offset + limit && predictiveWindowFitsCap) {
        return predictive.slice(offset, offset + limit);
      }
    } else if (![404, 410].includes(suggestionResponse.status)) {
      throw new ProviderHttpError(
        'Mr Price Ireland',
        suggestionResponse.status
      );
    }

    // Shopify's predictive endpoint is narrower than its full search page.
    const htmlUrl = new URL('/search', this.baseUrl);
    htmlUrl.searchParams.set('type', 'product');
    htmlUrl.searchParams.set('q', normalizedQuery);
    const response = await this.fetcher(htmlUrl, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new ProviderHttpError('Mr Price Ireland', response.status);
    }
    const html = await responseText(response);
    return parseHtmlProducts(html, this.baseUrl, limit, offset, normalizedQuery);
  }
}
