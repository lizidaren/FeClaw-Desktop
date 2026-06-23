#!/bin/bash
# js-check.sh — JS 语法检查
# 扫描 src-tauri/src/ 下所有 .js 文件，用 node --check 检查语法
# 用法: ./scripts/js-check.sh
#        ./scripts/js-check.sh --quiet  (只显示错误)
# 返回码: 0 = 全通过, >0 = 错误数

QUIET=false
[[ "$1" == "--quiet" ]] && QUIET=true

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_DIR/src-tauri/src"

ERRORS=0
TOTAL=0

while IFS= read -r -d '' f; do
    TOTAL=$((TOTAL + 1))
    REL="${f#$SRC_DIR/}"
    OUTPUT=$(node --check "$f" 2>&1)
    if [ $? -eq 0 ]; then
        $QUIET || echo "  ✅ $REL"
    else
        echo "  ❌ $REL"
        echo "     $OUTPUT"
        ERRORS=$((ERRORS + 1))
    fi
done < <(find "$SRC_DIR" -name "*.js" -type f -print0)

echo ""
echo "═══════════════════════════"
echo "  $TOTAL files checked"
if [ $ERRORS -eq 0 ]; then
    echo "  ✅ 全部通过"
else
    echo "  ❌ $ERRORS 个文件有语法错误"
fi
echo "═══════════════════════════"

exit $ERRORS
