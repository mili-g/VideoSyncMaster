import os
import sys

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CURRENT_DIR not in sys.path:
    sys.path.insert(0, CURRENT_DIR)

from bootstrap.check_requirements_impl import check_requirements
from bootstrap.check_requirements_impl import json


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(1)

    req_path = sys.argv[1]
    is_json = "--json" in sys.argv

    missing = check_requirements(req_path)

    if is_json:
        result = {"missing": missing}
        print(json.dumps(result))
    else:
        if not missing:
            print("[Info] 所有依赖齐全.")
        else:
            print(f"[Info] 发现缺失的包: {', '.join(missing)}")
            print("[Info] 发现缺失的包，正在安装...")

    sys.exit(1 if missing else 0)
