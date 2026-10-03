/**
 * Runs the real CLI in a child process with the offline fakes installed.
 * Usage: tsx test/fixtures/store-routing-cli.ts <cli args...>
 * Prints a final `__ROUTING__ {json}` line on stderr describing loads and
 * network attempts so the parent test can assert on them.
 */
import { installFakes, loadCount, GUARDED_REAL_IDS, events } from './store-routing-fakes';
import * as fakes from './store-routing-fakes';

installFakes();

function report(): void {
  const loads = Object.fromEntries(GUARDED_REAL_IDS.map((id) => [id, loadCount(id)]));
  process.stderr.write(
    `\n__ROUTING__ ${JSON.stringify({
      loads,
      fetchCalls: fakes.fetchCalls,
      selects: events.selects,
      searches: events.searches.map(({ query, selectedStoreId, options }) => ({
        query,
        selectedStoreId,
        storeId: options.storeId,
      })),
      listStores: events.listStores,
    })}\n`
  );
}

const exit = process.exit.bind(process);
process.exit = ((code?: number) => {
  report();
  return exit(code);
}) as typeof process.exit;
process.on('beforeExit', report);

require('../../src/cli');
