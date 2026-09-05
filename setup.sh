#!/usr/bin/env bash
# setup.sh -- get Wbrowser working from nothing, in one command.
#
#   curl -fsSL https://raw.githubusercontent.com/w-partners/Wbrowser/main/setup.sh | bash
#
# It clones the repo, installs dependencies, puts `wb` on your PATH, opens the
# browser window and tells you what to do next. Nothing is installed system-wide
# and nothing needs sudo.
#
# !! Every step says what it is doing and stops on the first failure. A setup script
#    that half-works and exits 0 is worse than one that refuses -- you would spend the
#    next hour debugging a state nobody intended.

set -uo pipefail

REPO="${WBROWSER_REPO:-https://github.com/w-partners/Wbrowser.git}"
DEST="${WBROWSER_DIR:-$HOME/Wbrowser}"
BIN="$HOME/.local/bin"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  [ok] %s\n' "$*"; }
info() { printf '  -  %s\n' "$*"; }
# !! Something did not happen, but the install can still finish. Must be visible:
#    a step that quietly skips looks identical to one that worked.
warn() { printf '  [!] %s\n' "$*" >&2; }
die()  { printf '\n  [!!] %s\n\n' "$*" >&2; exit 1; }

# -- 0. Which machine is this -------------------------------------------------
# :: launch.js already knows how to find Chrome on every platform, so setup does not
#    repeat that. What differs *here* is only the shell and where `wb` should live.
case "$(uname -s)" in
  Darwin)                 PLATFORM=macos ;;
  MINGW*|MSYS*|CYGWIN*)   PLATFORM=windows-git-bash ;;
  Linux)
    if grep -qi microsoft /proc/version 2>/dev/null; then PLATFORM=wsl; else PLATFORM=linux; fi ;;
  *)                      PLATFORM="$(uname -s)" ;;
esac

say "Setting up for: $PLATFORM"

if [ "$PLATFORM" = "windows-git-bash" ]; then
  cat >&2 <<'EOF'

  [!!] This script is for macOS, Linux and WSL.

  On Windows you have two ways, and WSL is the easier one:

    A. WSL  (recommended)
         wsl --install          # once, in PowerShell as admin
         then open Ubuntu and run this same command inside it

    B. Windows natively -- PowerShell, no bash:
         git clone https://github.com/w-partners/Wbrowser.git
         cd Wbrowser
         $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; npm install
         node launch.js         # log into your sites in the window that opens
         node engine.js         # leave this running
         node bin\wbrowser.js go https://github.com

       `wb` is a bash script, so it does not run there -- use
       `node bin\wbrowser.js` in its place. Everything else is the same.

EOF
  exit 1
fi

# -- 1. What we need ----------------------------------------------------------
say "Checking what you have"

case "$PLATFORM" in
  macos)  GIT_HINT="xcode-select --install"
          NODE_HINT="brew install node   (or download from https://nodejs.org)" ;;
  wsl)    GIT_HINT="sudo apt install git"
          NODE_HINT="sudo apt install nodejs npm
     !! Install Node *inside WSL*, not on Windows -- this runs in WSL." ;;
  *)      GIT_HINT="sudo apt install git      (Fedora: sudo dnf install git)"
          NODE_HINT="sudo apt install nodejs npm   (or https://nodejs.org)" ;;
esac

command -v git >/dev/null 2>&1 || die "git is not installed.
     $GIT_HINT"

command -v node >/dev/null 2>&1 || die "Node.js is not installed (version 18 or later).
     $NODE_HINT"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18 or later is required. You have $(node -v)."
ok "node $(node -v)"

# :: Chrome is not required *yet* -- launch.js hunts for it across the usual install
#    locations and gives a per-platform message if it is missing. Checking here too
#    would mean maintaining that list twice, and the two copies would drift.
ok "git $(git --version | awk '{print $3}')"

# -- 1b. Clear whatever is already running ------------------------------------
# !! Re-running setup must land you in a known state, not add a second copy. Without
#    this the new engine dies on EADDRINUSE while the old one keeps serving, and every
#    change you make afterwards appears to do nothing.
#
#    Measured 2026-08-24: a *different project's* engine held port 7981 for ten hours.
#    Every command went to it, so fixes to this code had no visible effect and were
#    debugged for hours. That is the failure this section exists to prevent.
#
# :: Chrome is never touched. It may be the window you are working in, and the profile
#    on disk keeps your logins either way -- there is nothing to gain by closing it.
say "Clearing anything already running"

# :: ss on Linux, lsof on macOS. !! If neither exists we say so rather than returning
#    "nothing is listening" -- that would silently skip the cleanup this section is for.
if command -v ss >/dev/null 2>&1; then
  _port_pid() { ss -lptnH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
elif command -v lsof >/dev/null 2>&1; then
  _port_pid() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1; }
else
  info "no 'ss' or 'lsof' here, so a running engine cannot be found and stopped"
  info "if setup fails with EADDRINUSE, stop the old engine yourself and re-run"
  _port_pid() { echo ""; }
fi

for _port in 7981 7983; do
  _pid="$(_port_pid "$_port")"
  [ -n "$_pid" ] || continue
  # !! Check what it actually is before killing it. The port number alone is not
  #    identification -- see the ten-hour bug above.
  # :: /proc is Linux-only; macOS answers the same question through ps.
  if [ -r "/proc/$_pid/cmdline" ]; then
    _cmd="$(tr '\0' ' ' < "/proc/$_pid/cmdline" 2>/dev/null || echo '')"
  else
    _cmd="$(ps -o command= -p "$_pid" 2>/dev/null || echo '')"
  fi
  case "$_cmd" in
    *engine.js*|*mcp-server.js*)
      kill "$_pid" 2>/dev/null && info "stopped engine on :$_port (pid $_pid)"
      ;;
    '')
      info "port :$_port is held by pid $_pid, which we cannot inspect -- leaving it"
      ;;
    *)
      # A foreign program on our port. Killing it would be overreach; say so and stop.
      die "Port :$_port is in use by something that is not Wbrowser:
       pid $_pid  --  $(printf '%.60s' "$_cmd")
     Close it yourself, or run Wbrowser elsewhere with WBROWSER_PORT=<other>."
      ;;
  esac
done

# Wait for the ports to actually free up. `kill` returns immediately; binding does not.
for _ in $(seq 1 20); do
  [ -z "$(_port_pid 7981)" ] && break
  sleep 0.25
done
[ -z "$(_port_pid 7981)" ] || die "Port :7981 is still held after stopping the engine.
     Check with: ss -lptn 'sport = :7981'"
ok "ports free"

# -- 2. The code ------------------------------------------------------------
say "Getting Wbrowser"
if [ -d "$DEST/.git" ]; then
  info "already at $DEST -- updating"
  git -C "$DEST" pull --ff-only >/dev/null 2>&1 || info "could not fast-forward; keeping what you have"
else
  [ -e "$DEST" ] && die "$DEST exists but is not a git clone. Move it aside, or set WBROWSER_DIR."
  git clone --depth 1 "$REPO" "$DEST" >/dev/null 2>&1 || die "Could not clone $REPO"
fi
ok "$DEST"

# !! Some clones drop the executable bit. Without this `./wb` dies with a permission
#    error that reads like a broken install.
chmod +x "$DEST"/wb "$DEST"/*.sh "$DEST"/bin/*.js 2>/dev/null

# -- 3. Dependencies ----------------------------------------------------------
say "Installing dependencies"
info "skipping Playwright's browser download -- Wbrowser drives the Chrome you already have"
( cd "$DEST" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund --silent ) \
  || die "npm install failed. Run it yourself in $DEST to see why."
ok "installed"

# -- 4. Put wb on the PATH ----------------------------------------------------
say "Making 'wb' available everywhere"
mkdir -p "$BIN"
ln -sf "$DEST/wb" "$BIN/wb"
ok "$BIN/wb"

case ":$PATH:" in
  *":$BIN:"*) ok "$BIN is already on your PATH" ;;
  *)
    # !! Append to the right file for the shell they actually use, and only if it is
    #    not already there -- running setup twice must not leave two copies.
    case "${SHELL##*/}" in
      zsh)  RC="$HOME/.zshrc" ;;
      *)    RC="$HOME/.bashrc" ;;
    esac
    LINE='export PATH="$HOME/.local/bin:$PATH"'
    if ! grep -qF "$LINE" "$RC" 2>/dev/null; then
      printf '\n# added by Wbrowser setup\n%s\n' "$LINE" >> "$RC"
      ok "added to $(basename "$RC")"
    else
      ok "$(basename "$RC") already has it"
    fi
    info "open a new terminal, or run:  export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

# -- 4b. Teach the agent how to use it ----------------------------------------
# !! Without this the tool is installed and nothing knows it exists. `wb` on the PATH
#    only helps a human who already knows the commands; an agent needs to be told when
#    to reach for it, how, and what never to do (passwords, cookie values, closing the
#    human's Chrome). Shipping the binary without the instructions is half an install.
say "Installing the agent skill"
SKILL_SRC="$DEST/skills/wbrowser/SKILL.md"
SKILL_DIR="$HOME/.claude/skills/wbrowser"
if [ -f "$SKILL_SRC" ]; then
  mkdir -p "$SKILL_DIR"
  if [ -e "$SKILL_DIR/SKILL.md" ] && ! cmp -s "$SKILL_SRC" "$SKILL_DIR/SKILL.md"; then
    # !! Never clobber a skill they wrote or edited. Put the new one alongside and say so.
    cp "$SKILL_SRC" "$SKILL_DIR/SKILL.md.new"
    warn "you already have a different $SKILL_DIR/SKILL.md"
    info "left the new one at SKILL.md.new -- compare with: diff $SKILL_DIR/SKILL.md{,.new}"
  else
    cp "$SKILL_SRC" "$SKILL_DIR/SKILL.md"
    ok "$SKILL_DIR/SKILL.md"
  fi
else
  warn "skill file missing from this copy -- agents will not know how to drive the browser"
fi

# -- 4b-2. Register the MCP server so agents can DISCOVER the browser as a tool --------------
# !! The skill above tells an agent HOW to use wbrowser, but an agent still has to think to
#    reach for it. Built-in browser tools (e.g. Claude's own in-chrome tool) sit right in the
#    tool list, so they get picked first -- even by us. Registering wbrowser as an MCP server
#    puts it in that same list, next to them, so "I need a logged-in browser" surfaces wbrowser
#    directly. Local stdio only: no port, no token, no network exposure -- only this machine's
#    agent process can reach it (the remote/http mode, which does need a token, is untouched).
if command -v claude >/dev/null 2>&1; then
  say "Registering the MCP server (so agents see the browser as a tool)"
  # Idempotent: replace any prior registration pointing at this install.
  claude mcp remove wbrowser >/dev/null 2>&1 || true
  if claude mcp add wbrowser -- node "$DEST/mcp-server.js" >/dev/null 2>&1; then
    ok "MCP server 'wbrowser' registered (local stdio → node $DEST/mcp-server.js)"
    info "agents now see wbrowser in their tool list. Remove with: claude mcp remove wbrowser"
  else
    warn "could not register the MCP server automatically"
    info "add it by hand:  claude mcp add wbrowser -- node $DEST/mcp-server.js"
  fi
else
  # Not a Claude-CLI environment (another agent runtime, or CLI not installed). Tell them how.
  info "to let an agent discover the browser as a tool, register the MCP server for your agent:"
  info "  command: node $DEST/mcp-server.js   (local stdio — no token needed)"
  info "  Claude CLI:  claude mcp add wbrowser -- node $DEST/mcp-server.js"
fi

# -- 4c. Keep the engine running across reboots -------------------------------
# !! The engine already survives the terminal that started it, but not a reboot. Without
#    this, the first session after a restart meets "Engine is not running" and has to
#    know to run `wb up`. Registering the unit is part of installing, not an extra step
#    to read about at the end -- this used to be a printed suggestion and was skipped.
if [ "$PLATFORM" = "linux" ] || [ "$PLATFORM" = "wsl" ]; then
  say "Starting the engine with your session"
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    if (cd "$DEST" && ./install.sh >/dev/null 2>&1); then
      ok "systemd user service registered"
    else
      warn "could not register the service -- run 'wb up' after a reboot"
    fi
  else
    # !! WSL without systemd is common. Say what to do instead of failing quietly.
    info "no systemd here -- run 'wb up' after a reboot (or enable systemd in /etc/wsl.conf)"
  fi
fi

# -- 5. Start it ------------------------------------------------------------
say "Starting Chrome"
case "$PLATFORM" in
  wsl)
    info "under WSL this opens your *Windows* Chrome -- the one you already use"
    # !! /mnt/c/Users usually holds several folders -- the real account plus Windows'
    #    own (Public, Default, WsiAccount...). launch.js refuses to guess between them,
    #    correctly, but that stops setup with a message most people cannot act on.
    #    Work out the right one here, where we can: the account folder is the one that
    #    actually belongs to a person, i.e. it has a Desktop *and* a Downloads.
    if [ -z "${WBROWSER_PROFILE_DIR:-}" ]; then
      _found=""
      for _u in /mnt/c/Users/*/; do
        _n="$(basename "$_u")"
        case "$_n" in All\ Users|Default|Default\ User|Public|desktop.ini) continue ;; esac
        if [ -d "$_u/Desktop" ] && [ -d "$_u/Downloads" ]; then
          _found="${_found}${_found:+ }$_n"
        fi
      done
      # Only act when it is unambiguous. Two candidates is exactly the case where
      # picking one silently would put the profile in a stranger's home folder.
      if [ "$(printf '%s\n' $_found | wc -l)" = "1" ] && [ -n "$_found" ]; then
        export WBROWSER_PROFILE_DIR="/mnt/c/Users/$_found/.wbrowser"
        info "Windows account: $_found"
      fi
    fi
    ;;
  macos) info "if macOS asks for permission to control Chrome, allow it" ;;
esac
if ! ( cd "$DEST" && node launch.js ); then
  case "$PLATFORM" in
    wsl) die "Chrome would not start -- read the message above, it names the cause.

     If it says 'several user folders', tell it which Windows account is yours:
       ls /mnt/c/Users                      # find your account folder
       WBROWSER_PROFILE_DIR=/mnt/c/Users/<you>/.wbrowser $DEST/wb up

     If it says Chrome was not found:
       WBROWSER_CHROME='/mnt/c/Program Files/Google/Chrome/Application/chrome.exe' $DEST/wb up

     If it says WSL interop is off, Windows programs cannot be started from WSL --
     check that /proc/sys/fs/binfmt_misc/WSLInterop exists." ;;
    macos) die "Chrome would not start. The message above says why.
     Most often Chrome is not in /Applications. Point at it directly:
       WBROWSER_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' $DEST/wb up" ;;
    *) die "Chrome would not start. The message above says why.
     Most often Chrome/Chromium is not installed, or sits somewhere unusual:
       WBROWSER_CHROME=/usr/bin/google-chrome $DEST/wb up
     On a server with no screen, Wbrowser goes headless by itself -- but you cannot
     log in by hand there. Use ./sync-session.sh to bring sessions from a desktop." ;;
  esac
fi

say "Starting the control engine"
( cd "$DEST" && nohup node engine.js > "${XDG_STATE_HOME:-$HOME/.local/state}/wbrowser/engine.log" 2>&1 & ) 2>/dev/null
for _ in $(seq 1 25); do
  curl -s --max-time 2 http://127.0.0.1:7981/health 2>/dev/null | grep -q '"ok"' && break
  sleep 0.4
done
curl -s --max-time 2 http://127.0.0.1:7981/health 2>/dev/null | grep -q '"ok"' \
  || die "The engine did not come up. Try '$DEST/wb up' to see the error."
ok "running"

# -- Done ------------------------------------------------------------
cat <<EOF

------------------------------------------------------------
 Wbrowser is ready.

 A Chrome window just opened. It is empty on purpose.

   1. Log into your sites in that window -- by hand, as usual.
      Wbrowser never sees your password. Chrome keeps the session,
      and Wbrowser only drives the window that is already open.

   2. Then try it:

        wb go https://github.com
        wb read

   3. After a reboot, one command brings it all back:

        wb up
$(case "$PLATFORM" in
  wsl)   printf '%s\n' "      (open a WSL terminal first -- Windows does not start WSL by itself)" ;;
  linux) printf '%s\n' "      Or have the engine start with your session:  cd $DEST && ./install.sh" ;;
  macos) printf '%s\n' "      (no auto-start installer on macOS yet -- run 'wb up' when you need it)" ;;
esac)

 Full guide: $DEST/README.md
             https://github.com/w-partners/Wbrowser
------------------------------------------------------------

EOF
