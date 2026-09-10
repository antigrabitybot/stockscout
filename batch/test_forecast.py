import math
import unittest
from forecast import prepare, result_row


class ForecastTests(unittest.TestCase):
    def row(self):
        import datetime as dt
        return {'code': '7203', 'name': 'Test', 'source': 'fixture', 'history': [
            {'date': (dt.date(2025, 1, 1) + dt.timedelta(days=i)).isoformat(), 'close': 100 + i}
            for i in range(520)]}

    def test_last_512_and_log_normalization(self):
        history, values = prepare(self.row())
        self.assertEqual(len(values), 512)
        self.assertEqual(values[-1], 0)
        self.assertAlmostEqual(math.exp(values[0]) * history[-1]['close'], history[0]['close'])

    def test_invalid_input_not_imputed(self):
        for invalid in [None, 0, -1, math.nan, math.inf]:
            row = self.row()
            row['history'][-1]['close'] = invalid
            with self.assertRaises(ValueError):
                prepare(row)
        row = self.row()
        row['history'][-1]['date'] = row['history'][-2]['date']
        with self.assertRaises(ValueError):
            prepare(row)

    def test_multi_day_level_quantiles_not_summed(self):
        row = self.row()
        history, _ = prepare(row)
        q = [[0, math.log(.9), 0, 0, 0, 0, 0, 0, 0, math.log(1.1)]] * 20
        result = result_row(row, history, [0] * 20, q)
        self.assertEqual(result['path'][-1]['price'], history[-1]['close'])
        self.assertAlmostEqual(result['path'][-1]['high'], round(history[-1]['close'] * 1.1, 2))
        self.assertEqual(result['path'][0]['return'], 0)

    def test_short_history_and_invalid_output_rejected(self):
        row = self.row()
        with self.assertRaises(ValueError):
            prepare({**row, 'history': row['history'][:100]})
        with self.assertRaises(ValueError):
            result_row(row, row['history'], [math.nan] * 20, [[0]*10]*20)


if __name__ == '__main__':
    unittest.main()
