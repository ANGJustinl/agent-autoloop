#!/bin/sh
# Says how much CI a pull request needs, as scope=docs, normal, kernel or full. The slow simulations only cover kernel/,
# protocol/ and sim/, so other code skips them, and text no test reads skips everything. kernel/ and protocol/ get a short
# simulation, since breaking each kernel condition in turn showed the quick tests already catch what the long runs do. A
# file this doesn't name, or a diff it can't get, means full. So does everything that reaches main, text too: the long runs
# still come, 12 minutes behind, and a commit whose run a newer push replaced is checked by the next one, whatever that is.
set -u

# Without --no-renames, moving a file out of kernel/ would show only where it landed.
if [ "${GITHUB_EVENT_NAME:-}" != pull_request ] ||
  ! files=$(git diff --no-renames --name-only HEAD^1 HEAD 2>/dev/null) || [ -z "$files" ]; then
  echo "scope=full"
  exit 0
fi

scope=docs
while IFS= read -r file; do
  case "$file" in
    # tests/example-plugins.test.ts runs the commands in this tutorial.
    docs/plugins.md) kind=normal ;;
    README.md | README.en.md | INSTALL.md | SECURITY.md | CONTRIBUTING.md | AGENTS.md | LICENSE) kind=docs ;;
    docs/* | .github/ISSUE_TEMPLATE/* | .github/pull_request_template.md) kind=docs ;;
    tests/simulation.test.ts) kind=full ;;
    kernel/* | protocol/*) kind=kernel ;;
    plugins/* | examples/* | skills/* | worker/* | host/* | cli/* | bin/* | scripts/* | tests/* | install.sh) kind=normal ;;
    *) kind=full ;;
  esac
  case "$kind" in
    full) scope=full ;;
    kernel) [ "$scope" = full ] || scope=kernel ;;
    normal) [ "$scope" = docs ] && scope=normal ;;
  esac
done <<END
$files
END

echo "scope=$scope"
