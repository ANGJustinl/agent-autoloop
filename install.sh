#!/bin/sh
# Installs Agent 自动化中台: a clone in ~/.agent-autoloop/app, with nothing to build and nothing else to install.
set -e
PUBLISHED=https://github.com/KKKKhazix/agent-autoloop.git
REPO="${AGENT_AUTOLOOP_REPO:-$PUBLISHED}"
ROOT="${AGENT_AUTOLOOP_HOME:-$HOME/.agent-autoloop}"
APP="$ROOT/app"
PROGRAM="$APP/bin/agent-autoloop.ts"

need_node() {
  echo "$1"
  cat <<'END'
用 Homebrew 的话，node@24 装好后默认不在 PATH 上，这三行都要运行（用 bash 就把 ~/.zshrc 换成 ~/.bashrc）：
  brew install node@24
  echo "export PATH=\"$(brew --prefix node@24)/bin:\$PATH\"" >> ~/.zshrc
  source ~/.zshrc
用 nvm 的话：
  nvm install 24
  nvm alias default 24
装好后再运行一遍这个安装命令。
END
  exit 1
}

command -v git >/dev/null || { echo "需要 git。"; exit 1; }
command -v node >/dev/null || need_node "需要 Node.js 24 或更新，这台电脑上没找到。"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || need_node "需要 Node.js 24 或更新，现在是 $(node -v)。"

mkdir -p -m 700 "$ROOT"
chmod 700 "$ROOT"

# A copy follows where it came from, and what came from the public repository follows its newest release, which has passed
# every check. cli/update.ts decides the same way, or an update would fail on a copy this had moved.
from="$REPO"
if [ -d "$APP/.git" ]; then from=$(git -C "$APP" config --get remote.origin.url || true); fi
release=""
if [ "$from" = "$PUBLISHED" ]; then
  # On a line of its own: in a pipe, not getting an answer would look like there being no releases.
  tags=$(git ls-remote --refs --tags "$PUBLISHED" 'v*')
  # v1.0.0 can only pull a branch, so a copy sent there could never leave.
  release=$(printf '%s\n' "$tags" | sed -n -e '/refs\/tags\/v1\.0\.0$/d' -e 's#.*refs/tags/\(v[0-9]*\.[0-9]*\.[0-9]*\)$#\1#p' |
    sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1)
fi
if [ ! -d "$APP/.git" ]; then
  git -c advice.detachedHead=false clone --quiet --depth 1 ${release:+--branch "$release"} -- "$REPO" "$APP"
elif [ -n "$release" ]; then
  git -C "$APP" fetch --quiet --depth 1 origin "+refs/tags/$release:refs/tags/$release"
  git -C "$APP" checkout --quiet --detach "$release"
else
  git -C "$APP" pull --ff-only --quiet
fi

# Only a folder that's on PATH makes `agent-autoloop` work, and an agent-autoloop that isn't this one is someone else's to keep.
place_link() {
  case ":$PATH:" in *":$1:"*) ;; *) return 1 ;; esac
  case "$1" in /*) ;; *) return 1 ;; esac
  if [ "$1" = "$HOME/.local/bin" ]; then mkdir -p "$1" 2>/dev/null || return 1; fi
  [ -d "$1" ] && [ -w "$1" ] || return 1
  if [ -e "$1/agent-autoloop" ] || [ -L "$1/agent-autoloop" ]; then
    [ -L "$1/agent-autoloop" ] && [ "$1/agent-autoloop" -ef "$PROGRAM" ] || return 1
  fi
  ln -sf "$PROGRAM" "$1/agent-autoloop"
}

usual_ifs=$IFS
IFS=:
set -f
for place in "$HOME/.local/bin" $PATH; do
  if place_link "$place"; then break; fi
done
set +f
IFS=$usual_ifs

if [ -f "$ROOT/config.json" ]; then
  echo "更新好了。"
  case " $* " in *" --no-service "*) ;; *) "$PROGRAM" service install ;; esac
else
  "$PROGRAM" init "$@"
fi

if ! [ "$(command -v agent-autoloop)" -ef "$PROGRAM" ]; then
  echo
  echo "直接打 agent-autoloop 运行不了这个程序：PATH 上没有能放它的目录，或者排在前面的是另一个同名程序。"
  echo "要写完整路径 $PROGRAM，或者把这一行加进 ~/.zshrc（用 bash 就是 ~/.bashrc）："
  echo "  alias agent-autoloop='$PROGRAM'"
fi
