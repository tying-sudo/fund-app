import json
with open('data/confidence_deviations.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
print(f'Total funds: {len(data)}')
dates = set()
sample = list(data.items())[:3]
for k, v in sample:
    hist = v.get('confidence_history', {})
    dates.update(hist.keys())
    print(f'{k}: confidence_history={len(hist)}d, deviations={len(v.get("deviations",{}))}d')
if dates:
    ds = sorted(dates)
    print(f'Date range: {ds[0]} ~ {ds[-1]}')
    print(f'Latest data date: {ds[-1]}')
