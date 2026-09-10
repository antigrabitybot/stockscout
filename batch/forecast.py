"""Daily TimesFM forecasts. Input history stays private; outputs contain estimates.

Forecast normalized log price levels, not sums of daily quantiles: marginal
return quantiles cannot be summed into a multi-day confidence interval.
"""
import argparse
import contextlib
import datetime as dt
import json
import math
import os
from pathlib import Path
import sys
import ssl
import urllib.request

MODEL = 'google/timesfm-2.5-200m-pytorch'
CONTEXT = 512
HORIZON = 20


def nikkei_history():
    import certifi
    url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?range=5y&interval=1d'
    req = urllib.request.Request(url, headers={'User-Agent': 'StockScout research'})
    with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context(cafile=certifi.where())) as response:
        result = json.load(response)['chart']['result'][0]
    if result['meta']['symbol'] != '^N225':
        raise ValueError('日経平均と異なる指数です')
    # Today's value may still be intraday. Only completed Tokyo sessions enter.
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=9)))
    history = []
    for stamp, close in zip(result['timestamp'], result['indicators']['quote'][0]['close']):
        day = dt.datetime.fromtimestamp(stamp, now.tzinfo).date()
        if day == now.date() and now.hour < 16:
            continue
        if close is not None:
            history.append({'date': day.isoformat(), 'close': close})
    return {'code': '^N225', 'name': '日経平均', 'source': 'Yahoo Finance (^N225)', 'history': history}


def prepare(row):
    history = row['history']
    if len(history) < 128:
        raise ValueError('履歴不足（128営業日以上必要）')
    history = history[-CONTEXT:]
    dates = [p['date'] for p in history]
    if dates != sorted(set(dates)):
        raise ValueError('価格履歴の日付順・重複を確認してください')
    for p in history:
        dt.date.fromisoformat(p['date'])
        if not isinstance(p['close'], (int, float)) or not math.isfinite(p['close']) or p['close'] <= 0:
            raise ValueError('価格履歴に欠損または不正値があります')
    base = history[-1]['close']
    return history, [math.log(p['close'] / base) for p in history]


def result_row(row, history, point, quantiles):
    base = history[-1]['close']
    path = []
    for i in range(HORIZON):
        values = [float(point[i]), float(quantiles[i][1]), float(quantiles[i][9])]
        if not all(math.isfinite(v) and abs(v) < 5 for v in values):
            raise ValueError('モデル出力が不正です')
        mid, low, high = [base * math.exp(v) for v in values]
        if not low <= mid <= high:
            raise ValueError('予測分位点の順序が不正です')
        path.append({'day': i + 1, 'price': round(mid, 2), 'low': round(low, 2),
                     'high': round(high, 2), 'return': math.expm1(values[0])})
    return {**{k: row[k] for k in ('code', 'name', 'source')}, 'status': 'ok',
            'asof': history[-1]['date'], 'base': base, 'path': path}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', default='.state/forecast-input.json')
    parser.add_argument('--output', default='public/data/forecasts.json')
    parser.add_argument('--limit', type=int, default=0)
    args = parser.parse_args()
    rows = json.loads(Path(args.input).read_text())
    if args.limit:
        rows = rows[:args.limit]
    errors = []
    try:
        rows.insert(0, nikkei_history())
    except Exception as exc:
        print(f'Nikkei source failed: {type(exc).__name__}', file=sys.stderr)
        errors.append({'code': '^N225', 'name': '日経平均', 'status': 'unavailable',
                       'reason': '日経平均データを取得できませんでした'})
    prepared = []
    for row in rows:
        try:
            history, inputs = prepare(row)
            prepared.append((row, history, inputs))
        except (ValueError, TypeError, KeyError) as exc:
            errors.append({'code': row['code'], 'name': row['name'],
                           'status': 'unavailable', 'reason': str(exc)})
    if not prepared:
        raise ValueError('予測可能な履歴がありません')
    # Bound CPU memory and runtime. No per-ticker model reloads.
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import torch
        import timesfm
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(MODEL, force_download=False)
        model.compile(timesfm.ForecastConfig(
            max_context=CONTEXT, max_horizon=32, per_core_batch_size=8,
            normalize_inputs=True, infer_is_positive=False,
            use_continuous_quantile_head=True, fix_quantile_crossing=True))
        results = []
        for start in range(0, len(prepared), 8):
            chunk = prepared[start:start + 8]
            point, quantiles = model.forecast(
                horizon=HORIZON, inputs=[np.asarray(x[2], dtype=np.float32) for x in chunk])
            for (row, history, _), p, q in zip(chunk, point, quantiles):
                try:
                    results.append(result_row(row, history, p, q))
                except ValueError as exc:
                    errors.append({'code': row['code'], 'name': row['name'],
                                   'status': 'unavailable', 'reason': str(exc)})
            print(f'Forecast {min(start + 8, len(prepared))}/{len(prepared)}', flush=True)
    if not results:
        raise ValueError('有効な予測がありません')
    output = {'model': MODEL, 'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
              'context': CONTEXT, 'horizon': HORIZON, 'rows': results + errors}
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(output, ensure_ascii=False, allow_nan=False))
    temp.replace(target)


if __name__ == '__main__':
    main()
