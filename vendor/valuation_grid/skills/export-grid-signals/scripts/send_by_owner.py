#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Send grid signals filtered by owner. Usage: send_by_owner.py <owner_name>"""
import sys, os, json
sys.stdout.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_grid_signals import export_grid_signals

def main():
    owner_filter = sys.argv[1] if len(sys.argv) > 1 else None
    
    result = export_grid_signals(auto_start_backend=True)
    if not result.get('success'):
        print(f"ERROR: {result.get('error')}")
        return 1
    
    messages = result.get('messages', {})
    sent = []
    for owner, data in messages.items():
        if owner_filter and owner != owner_filter:
            continue
        print(f"---OWNER:{owner}---")
        print(data['message'])
        print(f"---END---")
        sent.append(owner)
    
    if not sent:
        print(f"No signals for owner '{owner_filter}'" if owner_filter else "No signals")
    return 0

if __name__ == "__main__":
    sys.exit(main())
