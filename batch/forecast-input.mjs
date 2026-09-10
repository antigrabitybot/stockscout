// Export full precision history privately; dashboard history is rounded and undated.
import fs from 'node:fs';
import { loadStore } from './store.mjs';

export function forecastInput(store) {
  return Object.entries(store.jp || {}).map(([code, e]) => ({
    code, name: e.name, source: 'J-Quants',
    history: (e.bars || []).map(b => ({date: b[0], close: b[4]})),
  }));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = forecastInput(await loadStore());
  if (!rows.length) throw new Error('日本株ストアが空です');
  fs.mkdirSync('.state', {recursive: true});
  fs.writeFileSync('.state/forecast-input.json', JSON.stringify(rows));
}
