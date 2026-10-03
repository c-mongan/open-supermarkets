/**
 * Offline fakes for generic store-routing tests. Nothing here touches a
 * retailer: fake manifests are pushed into the live registry list, real
 * providers' loaders are wrapped so a test can prove they never ran, and
 * global fetch is replaced with a counter that refuses to make requests.
 */
import { PROVIDERS } from '../../src/providers/registry';
import type {
  Product,
  ProviderManifest,
  SearchOptions,
  Store,
  StoreSearchOptions,
} from '../../src/providers/types';

export interface SearchEvent {
  instance: number;
  query: string;
  selectedStoreId?: string;
  options: SearchOptions;
}

export const events = {
  selects: [] as Array<{ instance: number; storeId: string; at: number }>,
  searches: [] as Array<SearchEvent & { at: number }>,
  listStores: [] as StoreSearchOptions[],
  reset() {
    this.selects.length = 0;
    this.searches.length = 0;
    this.listStores.length = 0;
  },
};

let clock = 0;
let instances = 0;

function product(name: string): Product {
  return {
    product_uid: name,
    name,
    retail_price: { price: 1 },
    currency: 'EUR',
    in_stock: null,
    provider: 'fake-stores',
  } as Product;
}

class FakeSearchOnlyProvider {
  readonly name = 'fake-search';
  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    events.searches.push({ instance: -1, query, options, at: ++clock });
    return [product(`${query}@legacy`)];
  }
}

/** Mirrors extracted store-scoped providers: selection is mutable instance state. */
class FakeStoreProvider {
  readonly name = 'fake-stores';
  private readonly instance = ++instances;
  private selectedStoreId?: string;

  async listStores(options: StoreSearchOptions = {}): Promise<Store[]> {
    events.listStores.push(options);
    return [
      { store_id: 's1', name: 'Fake One', postcode: 'D01', shopping_modes: ['pickup'] },
      { store_id: 's2', name: 'Fake Two', address: '2 Main St', shopping_modes: ['delivery'] },
    ];
  }

  async selectStore(storeId: string): Promise<void> {
    if (storeId === 'bad') {
      throw Object.assign(new Error('unknown store'), { name: 'ProviderInputError' });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.selects.push({ instance: this.instance, storeId, at: ++clock });
    this.selectedStoreId = storeId;
  }

  async search(query: string, options: SearchOptions = {}): Promise<Product[]> {
    if (options.storeId !== undefined && options.storeId !== this.selectedStoreId) {
      throw new Error(`storeId ${options.storeId} was not selected`);
    }
    const seen = this.selectedStoreId;
    events.searches.push({ instance: this.instance, query, selectedStoreId: seen, options, at: ++clock });
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
    // Mutating our options must never reach another query's options.
    (options as Record<string, unknown>).mutated = query;
    return [product(`${query}@${seen ?? 'none'}`)];
  }
}

/** Declares `stores` but is missing selectStore/listStores: a method guard, not a crash. */
class FakeBrokenStoreProvider {
  readonly name = 'fake-stores-broken';
  async search(): Promise<Product[]> {
    return [];
  }
}

const loads: Record<string, number> = {};

export function loadCount(id: string): number {
  return loads[id] ?? 0;
}

function fake(id: string, capabilities: ProviderManifest['capabilities'], ctor: any): ProviderManifest {
  return {
    id,
    label: id,
    country: 'XX',
    capabilities,
    auth: 'none',
    tier: 'community',
    load: async () => {
      loads[id] = (loads[id] ?? 0) + 1;
      return ctor;
    },
  };
}

export const FAKE_IDS = ['fake-stores', 'fake-search', 'fake-stores-broken'];

/** Real providers whose code must not load when a store route is refused. */
export const GUARDED_REAL_IDS = ['lidl-ie', 'ahorramas', 'mercadona'];

export let fetchCalls = 0;

export function installFakes(): () => void {
  const added = [
    fake('fake-stores', ['search', 'stores'], FakeStoreProvider),
    fake('fake-search', ['search'], FakeSearchOnlyProvider),
    fake('fake-stores-broken', ['search', 'stores'], FakeBrokenStoreProvider),
  ];
  PROVIDERS.push(...added);

  const originalLoads = new Map<ProviderManifest, ProviderManifest['load']>();
  for (const m of PROVIDERS.filter((p) => GUARDED_REAL_IDS.includes(p.id))) {
    originalLoads.set(m, m.load);
    const original = m.load;
    m.load = async () => {
      loads[m.id] = (loads[m.id] ?? 0) + 1;
      return original();
    };
  }

  const g = globalThis as { fetch?: unknown };
  const originalFetch = g.fetch;
  g.fetch = async () => {
    fetchCalls++;
    throw new Error('network disabled in store-routing tests');
  };

  return () => {
    for (const m of added) PROVIDERS.splice(PROVIDERS.indexOf(m), 1);
    for (const [m, load] of originalLoads) m.load = load;
    g.fetch = originalFetch;
  };
}
