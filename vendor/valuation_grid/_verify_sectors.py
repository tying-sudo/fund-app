"""Verify 自选 funds still in their original sectors"""
import json

with open('E:/Git/valuation_grid/data/state.json', encoding='utf-8') as f:
    state = json.load(f)

target = {'010524', '017560'}
found = set()
for s in state.get('sectors', []):
    for f in s.get('funds', []):
        code = f['code']
        if code in target:
            found.add(code)
            print(f"  {code}  ->  [{s['name']}]")

if target - found:
    print(f"  MISSING from sectors: {target - found}")
else:
    print(f"  全部正确，两只基金都在各自的板块中")
