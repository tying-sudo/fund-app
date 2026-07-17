"""
update_intraday_cache.py - 更新盘中估值缓存并保存

注意：必须使用 calculate_valuation_batch() 而非 calculate_valuation_by_state()，
因为后者只在内存中更新缓存，不持久化到文件。
calculate_valuation_batch() 在并发计算完成后统一持久化 intraday_cache.json。
"""
import json
import sys
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from valuation.core import calculate_valuation_batch

DATA_DIR = Path(__file__).parent.parent / "data"

def main():
    print("开始更新盘中估值缓存...")

    # 加载 state 获取所有基金代码
    state_file = DATA_DIR / "state.json"
    if not state_file.exists():
        print(f"错误：找不到 state 文件 {state_file}")
        return 1

    state = json.load(open(state_file, encoding="utf-8"))
    codes = [
        f["code"]
        for s in state.get("sectors", [])
        for f in s.get("funds", [])
        if f.get("code")
    ]
    print(f"共 {len(codes)} 只基金")

    # 使用 batch 接口计算估值（自动持久化 intraday_cache.json）
    results = calculate_valuation_batch(codes)
    print(f"估值计算完成：{len(results)} 只基金")

    # 验证缓存文件
    cache_file = DATA_DIR / "intraday_cache.json"
    if cache_file.exists():
        size = cache_file.stat().st_size
        print(f"缓存文件已更新：{size} bytes")
    else:
        print("警告：缓存文件未生成")

    return 0

if __name__ == "__main__":
    sys.exit(main())
