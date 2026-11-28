#!/usr/bin/env bash
# Tierwyn installer + doctor. Same file is the `tierwyn` PATH shim.
#
#   curl -fsSL https://raw.githubusercontent.com/tierwyn/tierwyn/main/scripts/install.sh | bash
#   tierwyn                         # interactive home (from a clone / PATH shim)
#   tierwyn setup                    # guided install / update (alias: install)
#   tierwyn doctor                   # diagnostics only (exit 1 on failures)
#   tierwyn agents                   # install agent CLIs
#   tierwyn services                 # (re)render + enable systemd user units
#   tierwyn sidecars                 # optional Piper / Kokoro TTS, Whisper STT, Grok Bot attach
#   tierwyn update                   # pull + rebuild + restart running services
#   tierwyn logs [target]            # follow service logs
#   tierwyn hub start|stop|restart|logs|status  # dedicated hub API + web (tierwyn-hub*)
#   tierwyn node setup|enroll|run|start|stop|restart|logs|update|allow|disallow|status  # remote-host daemon (not the hub)
#   -y | --yes                      # accept defaults, never prompt
#
# Env overrides: TIERWYN_DIR (clone target, default ~/tierwyn), TIERWYN_REPO, TIERWYN_NODE_MAJOR,
#   TIERWYN_KOKORO_PROFILE=cpu|cuda|rocm (skip detection), TIERWYN_HSA_OVERRIDE (ROCm gfx override).
#   TIERWYN_TUI=0  numbered prompts instead of inline cards.
#   MODE=hub|prod|dev with --yes picks that configure default (else dev).
#   TIERWYN_OPERATOR_PASSWORD (≥12) required for --yes hub/prod (never written to the env file).
#   TIERWYN_COOKIE_SECURE=true|false overrides the HTTPS cookie prompt when set.
set -euo pipefail

CFG="$HOME/.config/tierwyn"
UNIT_HOME="$HOME/.config/systemd/user"
unit_name() { echo "tierwyn-$1"; }   # base → unit name
# API + web pair: `prod` (tierwyn-prod*, dev-checkout prod — this repo's own box) or `hub`
# (tierwyn-hub*, dedicated hub user). Installed prod units win, so an existing prod box
# never flips; a hub-only box resolves to hub. Nothing installed: hub.env alone → hub.
unit_installed() { have systemctl && systemctl --user cat "$1.service" >/dev/null 2>&1; }
pair() {
  if unit_installed tierwyn-prod; then echo prod
  elif unit_installed tierwyn-hub; then echo hub
  elif [[ -r $CFG/hub.env && ! -r $CFG/prod.env ]]; then echo hub
  else echo prod; fi
}
api_unit() { unit_name "${1:-$(pair)}"; }
web_unit() { unit_name "${1:-$(pair)}-web"; }
pair_env() { echo "$CFG/${1:-$(pair)}.env"; }
home_dir() { echo "$HOME/tierwyn$1"; }   # suffix → install dir

TIERWYN_HUB_PKG_SHA256=""  # hub substitutes this line when serving /node/install.sh

REPO_URL=${TIERWYN_REPO:-https://github.com/tierwyn/tierwyn.git}
# 24 = Active LTS as of 2026-10. Floor 22.13 (first unflagged node:sqlite); 20 is EOL.
NODE_MAJOR=${TIERWYN_NODE_MAJOR:-24}
MIN_NODE=22

print_help() {
  cat <<'EOF'
tierwyn — Tierwyn installer, doctor and service control

Usage:
  tierwyn [command] [options]

Commands:
  tierwyn                Open interactive home menu
  tierwyn setup           Full guided setup (prereqs, build, config, agents, sidecars)
  tierwyn doctor          Run system & service health checks (exit 1 on failure)
  tierwyn status          Show running status of Tierwyn services and sidecars
  tierwyn config          Change run mode (dev/prod), port, password, and systemd units
  tierwyn start|stop|restart [target]
                         Manage services (target: prod, hub, all, piper, kokoro,
                         grokbot). No target = the installed API + web pair
                         (tierwyn-prod* if present, else tierwyn-hub*).
  tierwyn hub start|stop|restart|logs|status
                         Dedicated hub API + web (tierwyn-hub, tierwyn-hub-web)
  tierwyn update          Update to the channel's latest, rebuild workspaces, and restart services
  tierwyn channel [stable|edge]
                         Show or set the update channel: stable (default) = newest
                         release tag, edge = main. Never downgrades. Install with
                         TIERWYN_CHANNEL=edge to start on edge.
  tierwyn logs [target]   Follow live service logs via journalctl (default: API + web pair)
  tierwyn agents          Discover and install agent CLIs (Claude, Pi, Codex, Cursor...)
  tierwyn services        (Re)generate and enable systemd user units
  tierwyn sidecars        Install / configure optional voice & desktop helpers
  tierwyn linger          Keep services running after logout (sudo loginctl enable-linger)
  tierwyn node setup|enroll|run|start|stop|restart|logs|update|allow|disallow|status
                         Remote-host daemon (not the hub). Enroll (--agents a,b |
                         --all-agents), or `allow <agent>…`, then: tierwyn node
                         start. `status` shows config. `update` pulls (git) or
                         fetches the hub package, then restarts tierwyn-node.service.
                         `update --from-hub` converts a git host to ~/tierwyn-node;
                         `--allow-http` persists allowHttpPackage (enroll and --from-hub).
                         Package installs are node-only (no hub setup/update).
  tierwyn shim            Install / verify 'tierwyn' command in ~/.local/bin and PATH
  tierwyn help            Show this help guide

Optional Sidecars (tierwyn sidecars):
  • Piper TTS   (:5000)  Fast lightweight text-to-speech using local ONNX voices (CPU)
  • Kokoro TTS  (:8880)  High quality neural text-to-speech with natural voices (CPU/GPU)
  • Whisper STT          Local speech-to-text dictation via whisper.cpp + ffmpeg
  • Grok Bot    (:9333)  Desktop attach bridge for the x.ai Grok Electron application

Options:
  -y, --yes              Accept defaults automatically without prompting
  TIERWYN_TUI=0          Use plain numbered prompts instead of interactive cards
EOF
}

YES=0; CMD=""; TARGET=""
NODE_ARGS=(); IN_NODE=0
for a in "$@"; do
  if [[ $IN_NODE = 1 ]]; then
    case $a in
      -y|--yes) YES=1 ;;
      -h|--help) print_help; exit 0 ;;
      *) NODE_ARGS+=("$a") ;;
    esac
    continue
  fi
  case $a in
    -y|--yes) YES=1 ;;
    -h|--help) print_help; exit 0 ;;
    help) CMD=help ;;
    setup) CMD=setup ;;
    menu) CMD="" ;;
    install|doctor|agents|services|sidecars|config|update|linger|shim) CMD=$a ;;
    start|stop|restart|logs) [[ $CMD = hub ]] && TARGET=hub; CMD=$a ;;
    status) [[ $CMD = hub ]] && TARGET=hub; CMD=status ;;
    hub)
      if [[ $CMD =~ ^(start|stop|restart|logs)$ ]]; then TARGET=hub; else CMD=hub; fi
      ;;
    channel) CMD=channel ;;
    --force|force)
      if [[ $CMD = update ]]; then TARGET=--force
      else echo "unknown argument: $a (only 'tierwyn update --force')" >&2; exit 2; fi
      ;;
    stable|edge)
      if [[ $CMD = channel ]]; then TARGET=$a
      else echo "unknown argument: $a" >&2; exit 2; fi
      ;;
    prod|all|piper|kokoro|grokbot)
      if [[ $CMD =~ ^(start|stop|restart|logs)$ ]]; then TARGET=$a
      else echo "unknown argument: $a" >&2; exit 2; fi
      ;;
    node) CMD=node; IN_NODE=1 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
# tests: print parsed argv and exit before clone or dispatch
if [[ ${TIERWYN_INSTALL_PARSE_ONLY:-} = 1 ]]; then
  printf 'CMD=%s\nTARGET=%s\nYES=%s\nNODE_ARGS=%s\n' "$CMD" "$TARGET" "$YES" "${NODE_ARGS[*]}"
  exit 0
fi

# ── output ────────────────────────────────────────────────────────────────
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then B=$'\e[1m'; D=$'\e[2m'; R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; C=$'\e[36m'; N=$'\e[0m'
else B=; D=; R=; G=; Y=; C=; N=; fi
PASS=0; WARN=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
warn() { WARN=$((WARN+1)); printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  %s✘%s %s\n' "$R" "$N" "$*"; }
hint() { printf '      %s↳ %s%s\n' "$D" "$*" "$N"; }
step() { printf '\n%s%s▸ %s%s\n' "$B" "$C" "$*" "$N"; }
die()  { printf '%s✘ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# npm i -g against the official tarball lands shims in ~/.local/lib/node-v*/bin, not
# ~/.local/bin (only node/npm/npx are symlinked there). Vendor CLIs also use
# ~/.opencode/bin and ~/.grok/bin. systemd user units do not inherit the login PATH.
path_dirs() {
  local d np=""
  printf '%s\n' "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.opencode/bin" "$HOME/.grok/bin" "$HOME/.kiro/bin" "$HOME/.kimi-code/bin" "$HOME/.bun/bin"
  if have npm; then np=$(npm prefix -g 2>/dev/null) && [[ -n $np ]] && printf '%s\n' "$np/bin"; fi
  for d in "$HOME"/.local/lib/node-v*/bin; do [[ -d $d ]] && printf '%s\n' "$d"; done
}
export_agent_path() {
  local d p="$PATH"
  while read -r d; do
    [[ -n $d ]] || continue
    case ":$p:" in *":$d:"*) ;; *) p="$d:$p" ;; esac
  done < <(path_dirs)
  export PATH="$p"
}
sync_prod_path() {
  local f=${1:-$CFG/prod.env} tmp
  [[ -f $f ]] || return 0
  export_agent_path
  tmp=$(mktemp)
  ( umask 077; grep -v '^PATH=' "$f" >"$tmp"; printf 'PATH=%s\n' "$PATH" >>"$tmp"; mv "$tmp" "$f" )
  chmod 600 "$f"
}

banner() { # half-block render of apps/web/public/tierwyn-logo.svg + solid lettering
  local -a logo=(
    '██   ▄█▀█▄   ██'
    '██▄▄ █   █ ▄▄██'
    '██   ▀█▄█▀   ██'
    '██▄▄▄ ▄▀▄ ▄▄▄██'
    '██▀▀▀ ▀▄▀ ▀▀▀██'
    '██           ██'
    '██▄▄▄ ▄▀▄ ▄▄▄██'
    '██▀▀▀ ▀▄▀ ▀▀▀██'
    '██           ██'
  ) word=(
    ''
    '██████ ██████ ██████ █████  ██    ██ ██    ██ ██    ██'
    '  ██     ██   ██     ██  ██ ██    ██ ██    ██ ███   ██'
    '  ██     ██   ██     ██  ██ ██ ██ ██  ██  ██  ████  ██'
    '  ██     ██   █████  █████  ██ ██ ██   ████   ██ ██ ██'
    '  ██     ██   ██     ██ ██  ██ ██ ██    ██    ██  ████'
    '  ██     ██   ██     ██  ██ ███  ███    ██    ██   ███'
    '  ██   ██████ ██████ ██  ██ ██    ██    ██    ██    ██'
    "${N}${D}coding agent meta-harness — installer & doctor"
  ) i
  # Too narrow for the wordmark: mark + name only.
  (( ${_COLS:-80} < 78 )) && word=('' '' '' 'tierwyn' "${N}${D}coding agent meta-harness" '' '' '' '')
  echo
  for i in "${!logo[@]}"; do printf '  %s%s   %s%s\n' "$C" "${logo[i]}" "${word[i]}" "$N"; done
  echo
}

# ── prompts (inline cards when a TTY; numbered read otherwise) ────────────
[[ -t 0 ]] || YES=1
TUI=0
if [[ $YES = 0 && -t 0 && -t 2 && ${TERM:-} != dumb && ${TIERWYN_TUI:-1} != 0 && ${BASH_VERSINFO[0]} -ge 4 ]]; then
  TUI=1
fi
_TTY=/dev/tty
{ : >/dev/tty; } 2>/dev/null || _TTY=/dev/stderr   # -w passes even with no controlling terminal
_card_n=0
_hid=0
_hide() { printf '\e[?25l' >"$_TTY"; _hid=1; }
_show() { ((_hid)) || return 0; printf '\e[?25h' >"$_TTY" 2>/dev/null || true; _hid=0; }
_restore_cursor() { _show; }
hub_disconnect() { :; }
_on_exit() { _restore_cursor; hub_disconnect; }
trap '_on_exit' EXIT
trap '_on_exit; exit 130' INT
trap '_on_exit; exit 143' TERM

_oneline() { printf '%s' "${1//$'\n'/ }"; }
_fit() { # _fit str max → stdout
  local s=$1 max=$2
  (( max < 2 )) && { printf '%s' "$s"; return; }
  (( ${#s} <= max )) && { printf '%s' "$s"; return; }
  printf '%s…' "${s:0:$((max-1))}"
}

_redraw() {
  local out=""
  if (( _card_n > 0 )); then
    out+=$'\e['"$_card_n"$'A'
  fi
  local line
  _card_n=0
  for line in "$@"; do
    out+=$'\e[2K\r'"$line"$'\n'
    _card_n=$((_card_n+1))
  done
  out+=$'\e[J'
  printf '%s' "$out" >"$_TTY"
}

_collapse() {
  printf '%s◇%s  %s · %s%s%s\n' "$G" "$N" "$(_oneline "$1")" "$D" "$2" "$N" >"$_TTY"
}

_flush_tty() { # drop type-ahead: a CR+LF Enter leaves a LF that would auto-confirm the next prompt
  local _; while IFS= read -rsn1 -t 0.02 _ <"$_TTY"; do :; done
}

_key() {
  local k rest
  IFS= read -rsn1 k <"$_TTY" || return 1
  case $k in
    $'\e')
      IFS= read -rsn2 -t 0.05 rest <"$_TTY" || { echo esc; return; }
      case $rest in
        '[A') echo up ;;
        '[B') echo down ;;
        '[C'|'[D') echo none ;;
        *) echo esc ;;
      esac
      ;;
    ''|$'\n'|$'\r') echo enter ;;
    ' ') echo space ;;
    $'\t') echo tab ;;
    $'\177'|$'\b') echo bs ;;
    *) echo "$k" ;;
  esac
}

# Real terminal size: $LINES/$COLUMNS are unset in non-interactive bash.
_ROWS=24; _COLS=80
_term_size() {
  local r=24 c=80
  read -r r c < <(stty size <"$_TTY" 2>/dev/null || echo "24 80") || true
  _ROWS=${r:-24}; _COLS=${c:-80}
}
_term_size
_SEARCH_MIN=20   # lists this long get a search box + scrolling window

_too_tall() { # n_items → 0 if the card would exceed the terminal
  local n=$1
  (( n >= _SEARCH_MIN )) && n=4   # searchable lists scroll; they need only a small window
  (( n + 7 > _ROWS ))
}

_rep() { local s; printf -v s '%*s' "$2" ''; printf '%s' "${s// /$1}"; }

_vis_filter() { # q, tags, descs, n (caller locals) → vis; regex, case-insensitive, substring if half-typed
  vis=()
  local i hay
  shopt -s nocasematch
  for ((i=0; i<n; i++)); do
    hay="${tags[i]} ${descs[i]}"
    if [[ -z $q ]]; then vis+=("$i")
    elif [[ $hay =~ $q ]] 2>/dev/null; then vis+=("$i")
    elif [[ $hay == *"$q"* ]]; then vis+=("$i"); fi
  done
  shopt -u nocasematch
}

_window() { # cur, vis → top/end of the visible slice
  local m=${#vis[@]} room=$(( _ROWS - 9 ))
  (( room > 12 )) && room=12
  (( room < 3 )) && room=3
  (( cur < top )) && top=$cur
  (( cur >= top + room )) && top=$(( cur - room + 1 ))
  (( top > m - room )) && top=$(( m - room ))
  (( top < 0 )) && top=0
  end=$(( top + room < m ? top + room : m ))
}

_search_rows() { # q → search box rows (styled after the web model picker)
  local inner=$(( _COLS - 8 )) shown len
  (( inner > 56 )) && inner=56
  if [[ -z $q ]]; then shown="${D}Search… (regex)${N}"; len=15
  else shown=$(_fit "$q" $((inner - 4))); len=${#shown}; fi
  rows+=("${D}│${N}  ${C}╭$(_rep ─ "$inner")╮${N}")
  rows+=("${D}│${N}  ${C}│${N} ${shown}${C}▏${N}$(_rep ' ' $(( inner - len - 2 )))${C}│${N}")
  rows+=("${D}│${N}  ${C}╰$(_rep ─ "$inner")╯${N}")
}

_more_rows() { # top/end/vis → "↑ N more" / "↓ N more" markers (stable height)
  local m=${#vis[@]}
  if [[ $1 = top ]]; then
    if (( top > 0 )); then rows+=("${D}│      ↑ $top more${N}")
    else rows+=("${D}│${N}"); fi
    return 0
  fi
  if (( end < m )); then rows+=("${D}│      ↓ $(( m - end )) more${N}")
  elif (( m == 0 )); then rows+=("${D}│      no matches${N}")
  else rows+=("${D}│${N}"); fi
  return 0
}

_select() { # _select title default esc(cancel|no) tag desc ... → tag on stdout
  local title=$(_oneline "$1") def=$2 esc=$3; shift 3
  local tags=() descs=() vis=() i=0 cur=0 top=0 end=0 pad=0 q=""
  while (($#)); do
    tags+=("$1"); descs+=("$2")
    [[ $1 = "$def" ]] && cur=$i
    (( ${#1} > pad )) && pad=${#1}
    i=$((i+1)); shift 2
  done
  _term_size; _flush_tty
  local n=${#tags[@]} w=$_COLS key idx search=0
  (( n >= _SEARCH_MIN )) && search=1
  _vis_filter
  _hide
  while :; do
    local -a rows=()
    local m=${#vis[@]}
    _window
    rows+=("${C}◆${N}  $(_fit "$title" $((w-4)))")
    rows+=("${D}│${N}")
    (( search )) && { _search_rows; _more_rows top; }
    for ((idx=top; idx<end; idx++)); do
      i=${vis[idx]}
      local mark='  '
      (( idx == cur )) && mark="${C}${B}❯${N} "
      if [[ $n -eq 2 && ${tags[i]} =~ ^[yn]$ ]]; then
        rows+=("${D}│${N}  ${mark}$((i+1)). ${descs[i]}")
      else
        rows+=("${D}│${N}  ${mark}$(printf '%-*s' "$pad" "${tags[i]}")  ${D}$(_fit "${descs[i]}" $((w-pad-8)))${N}")
      fi
    done
    (( search )) && _more_rows end
    if (( search )); then
      rows+=("${D}└  $m results · type to filter · ↑↓ move · enter select · esc clear/cancel${N}")
    elif [[ $n -eq 2 && ${tags[0]} = y ]]; then
      rows+=("${D}└  ↑↓ move · enter select · y/n · esc = No${N}")
    else
      rows+=("${D}└  ↑↓/jk move · enter select · letter jumps · q/esc cancel${N}")
    fi
    _redraw "${rows[@]}"
    key=$(_key) || key=esc
    # Searchable: printable keys edit the query, navigation is arrows only.
    if (( search )); then
      case $key in
        up) (( m )) && cur=$(( (cur - 1 + m) % m )) ;;
        down) (( m )) && cur=$(( (cur + 1) % m )) ;;
        enter) (( m )) && { _redraw; _show; echo "${tags[vis[cur]]}"; return 0; } ;;
        esc)
          if [[ -n $q ]]; then q=""; cur=0; top=0; _vis_filter; continue; fi
          _redraw; _show
          [[ $esc = no ]] && { echo n; return 0; }
          printf '%s▲%s  cancelled\n' "$Y" "$N" >"$_TTY"
          return 1
          ;;
        bs) q=${q%?}; cur=0; top=0; _vis_filter ;;
        space) q+=' '; cur=0; top=0; _vis_filter ;;
        none|tab) ;;
        *) [[ ${#key} -eq 1 && $key != [[:cntrl:]] ]] && { q+=$key; cur=0; top=0; _vis_filter; } ;;
      esac
      continue
    fi
    case $key in
      up|k) cur=$(( (cur - 1 + n) % n )) ;;
      down|j) cur=$(( (cur + 1) % n )) ;;
      enter)
        _redraw
        _show
        echo "${tags[cur]}"
        return 0
        ;;
      esc|q)
        _redraw
        _show
        if [[ $esc = no ]]; then echo n; return 0; fi
        printf '%s▲%s  cancelled\n' "$Y" "$N" >"$_TTY"
        return 1
        ;;
      [1-9])
        idx=$((key-1))
        if (( idx < n )); then
          cur=$idx
          if (( n == 2 )); then
            _redraw
            _show
            echo "${tags[cur]}"
            return 0
          fi
        fi
        ;;
      y|n)
        if (( n == 2 )); then
          for ((i=0; i<n; i++)); do
            if [[ ${tags[i]} = "$key" ]]; then
              _redraw
              _show
              echo "${tags[i]}"
              return 0
            fi
          done
        fi
        for ((i=1; i<=n; i++)); do
          idx=$(( (cur + i) % n ))
          [[ ${tags[idx]:0:1} == "$key" ]] && { cur=$idx; break; }
        done
        ;;
      *)
        for ((i=1; i<=n; i++)); do
          idx=$(( (cur + i) % n ))
          [[ ${tags[idx]:0:1} == "$key" ]] && { cur=$idx; break; }
        done
        ;;
    esac
  done
}

_multi() { # _multi title tag desc on|off ... → space-separated tags
  local title=$(_oneline "$1"); shift
  local tags=() descs=() on=() vis=() i=0 cur=0 top=0 end=0 pad=0 q=""
  _flush_tty
  while (($#)); do
    tags+=("$1"); descs+=("$2"); on+=("$3")
    (( ${#1} > pad )) && pad=${#1}
    i=$((i+1)); shift 3
  done
  _term_size; _flush_tty
  local n=${#tags[@]} w=$_COLS key idx search=0
  (( n >= _SEARCH_MIN )) && search=1
  _vis_filter
  _hide
  while :; do
    local sel=0 m=${#vis[@]}
    for ((i=0; i<n; i++)); do [[ ${on[i]} = on ]] && sel=$((sel+1)); done
    local -a rows=()
    _window
    rows+=("${C}◆${N}  $(_fit "$title" $((w-4)))")
    rows+=("${D}│${N}")
    (( search )) && { _search_rows; _more_rows top; }
    for ((idx=top; idx<end; idx++)); do
      i=${vis[idx]}
      local box='◻' mark=' '
      [[ ${on[i]} = on ]] && box="${G}◼${N}"
      (( idx == cur )) && mark="${C}${B}❯${N}"
      rows+=("${D}│${N}  ${mark}${box} $(printf '%-*s' "$pad" "${tags[i]}")  ${D}$(_fit "${descs[i]}" $((w-pad-10)))${N}")
    done
    if (( search )); then
      _more_rows end
      rows+=("${D}└  $m results · type to filter · ↑↓ move · space toggle · tab all shown · enter confirm ($sel selected) · esc clear/skip${N}")
    else
      rows+=("${D}└  ↑↓/jk move · space toggle · a all/none · enter confirm ($sel selected) · esc skip${N}")
    fi
    _redraw "${rows[@]}"
    key=$(_key) || key=esc
    if (( search )); then
      case $key in
        up|down|space|enter|tab) ;;
        esc) [[ -n $q ]] && { q=""; cur=0; top=0; _vis_filter; continue; } ;;
        bs) q=${q%?}; cur=0; top=0; _vis_filter; continue ;;
        none) continue ;;
        *) [[ ${#key} -eq 1 && $key != [[:cntrl:]] ]] && { q+=$key; cur=0; top=0; _vis_filter; }; continue ;;
      esac
    fi
    case $key in
      up|k) (( m )) && cur=$(( (cur - 1 + m) % m )) ;;
      down|j) (( m )) && cur=$(( (cur + 1) % m )) ;;
      space) (( m )) && { i=${vis[cur]}; [[ ${on[i]} = on ]] && on[i]=off || on[i]=on; } ;;
      a|tab) # toggle every visible row: all on unless they already are
        local all=on
        for idx in "${vis[@]}"; do [[ ${on[idx]} = off ]] && { all=off; break; }; done
        [[ $all = on ]] && all=off || all=on
        for idx in "${vis[@]}"; do on[idx]=$all; done
        ;;
      enter)
        _redraw
        _show
        local -a out=()
        for ((i=0; i<n; i++)); do [[ ${on[i]} = on ]] && out+=("${tags[i]}"); done
        echo "${out[*]:-}"
        return 0
        ;;
      esc|q)
        _redraw
        _show
        echo ""
        return 0
        ;;
    esac
  done
}

_line_input() { # _line_input title default secret(0|1) → text
  local title=$(_oneline "$1") def=$2 secret=$3 buf="" key
  _hide; _flush_tty
  while :; do
    local shown w=$_COLS
    if [[ $secret = 1 ]]; then
      shown=""
      local j
      for ((j=0; j<${#buf}; j++)); do shown+='▪'; done
      [[ -z $shown ]] && shown="${D}${N}"
    else
      if [[ -z $buf ]]; then shown="${D}${def}${N}"; else shown=$buf; fi
    fi
    local -a rows=()
    rows+=("${C}◆${N}  $(_fit "$title" $((w-4)))")
    rows+=("${D}│${N}  $shown")
    if [[ $secret = 1 ]]; then
      rows+=("${D}└  enter confirm · backspace edit · input hidden${N}")
    else
      rows+=("${D}└  enter confirm · backspace edit${N}")
    fi
    _redraw "${rows[@]}"
    key=$(_key) || key=esc
    case $key in
      enter)
        _redraw
        _show
        if [[ $secret = 1 ]]; then echo "$buf"; else echo "${buf:-$def}"; fi
        return 0
        ;;
      esc)
        _redraw
        _show
        if [[ $secret = 1 ]]; then echo ""; else echo "$def"; fi
        return 0
        ;;
      bs) buf=${buf%?} ;;
      space) buf+=' ' ;;
      up|down) ;;
      *)
        [[ $key == [[:cntrl:]] ]] && continue
        [[ ${#key} -eq 1 ]] && buf+="$key"
        ;;
    esac
  done
}

_sum_sel() { # tags… → "a, b +N" for collapse
  local -a items=("$@")
  (( ${#items[@]} == 0 )) && { echo none; return; }
  local out="" i n=${#items[@]}
  for ((i=0; i<n; i++)); do
    local cand=${out:+$out, }${items[i]}
    if (( ${#cand} > 40 && i > 0 )); then echo "$out +$((n-i))"; return; fi
    out=$cand
  done
  echo "$out"
}

ask_yn() { # ask_yn "context\n\nquestion" default(y|n) — last paragraph is the question, earlier ones print above it
  local def=${2:-y} q; [[ $YES = 1 ]] && { [[ $def = y ]]; return; }
  printf -v q '%b' "$1"
  if [[ $q == *$'\n\n'* ]]; then printf '%s\n' "${q%$'\n\n'*}" | sed "s/^/  $D/; s/\$/$N/" >&2; q=${q##*$'\n\n'}; fi
  set -- "$q" "$def"
  if [[ $TUI = 1 ]] && ! _too_tall 2; then
    local r
    r=$(_select "$1" "$def" no y Yes n No) || r=n
    _collapse "$1" "$([[ $r = y ]] && echo Yes || echo No)"
    [[ $r = y ]]
    return
  fi
  local r; read -rp "  $1 [$( [[ $def = y ]] && echo Y/n || echo y/N )] " r
  r=${r:-$def}; [[ $r =~ ^[Yy] ]]
}

ask() { # ask "question" default → stdout
  [[ $YES = 1 ]] && { echo "$2"; return; }
  if [[ $TUI = 1 ]] && ! _too_tall 1; then
    local r
    r=$(_line_input "$1" "$2" 0)
    _collapse "$1" "$r"
    echo "$r"
    return
  fi
  local r; read -rp "  $1 [$2] " r; echo "${r:-$2}"
}

ask_secret() {
  [[ $YES = 1 ]] && { echo ""; return; }
  if [[ $TUI = 1 ]] && ! _too_tall 1; then
    local r
    r=$(_line_input "$1" "" 1)
    _collapse "$1" "••••••"
    echo "$r"
    return
  fi
  local r; read -rsp "  $1 " r; echo >&2; echo "$r"
}

menu() { # menu "title" default tag desc tag desc ... → tag
  local title=$1 def=$2; shift 2
  [[ $YES = 1 ]] && { echo "$def"; return; }
  if [[ $TUI = 1 ]] && ! _too_tall $(( $# / 2 )); then
    local r
    r=$(_select "$title" "$def" cancel "$@") || return 1
    _collapse "$title" "$r"
    echo "$r"
    return
  fi
  local tags=() i=1 d=1; echo "  $title" >&2
  while (($#)); do tags+=("$1"); [[ $1 = "$def" ]] && d=$i; printf '    %d) %s\n' "$i" "$2" >&2; i=$((i+1)); shift 2; done
  local r; read -rp "  choice [$d]: " r; r=${r:-$d}
  echo "${tags[$((r-1))]:-$def}"
}

checklist() { # checklist "title" tag desc on|off ... → space-separated tags
  local title=$1; shift
  if [[ $YES = 1 ]]; then local o=(); while (($#)); do [[ $3 = on ]] && o+=("$1"); shift 3; done; echo "${o[*]:-}"; return; fi
  if [[ $TUI = 1 ]] && ! _too_tall $(( $# / 3 )); then
    local r
    r=$(_multi "$title" "$@")
    local -a sel=()
    # ponytail: word-split is the existing checklist contract (tags are single tokens).
    read -ra sel <<<"$r"
    if (( ${#sel[@]} )); then _collapse "$title" "$(_sum_sel "${sel[@]}")"
    else _collapse "$title" none; fi
    echo "$r"
    return
  fi
  local tags=() i=1; echo "  $title" >&2
  while (($#)); do tags+=("$1"); printf '    %2d) %s %s\n' "$i" "$1" "$D$2$N" >&2; i=$((i+1)); shift 3; done
  local r n out=(); read -rp "  numbers (space-separated, blank = none): " r
  for n in $r; do [[ $n =~ ^[0-9]+$ ]] && [[ -n ${tags[$((n-1))]:-} ]] && out+=("${tags[$((n-1))]}"); done
  echo "${out[*]:-}"
}

# Defined before the piped bootstrap block — later functions do not exist yet when stdin is the script.
pkg_swap() { # pkg_swap <tgz> <target> [--smoke]
  local tgz=$1 target=$2 smoke=0
  [[ ${3:-} = --smoke ]] && smoke=1
  mkdir -p "$(dirname "$target")"
  local new
  new=$(mktemp -d "$target.new.XXXXXX")
  tar -xzf "$tgz" -C "$new" --strip-components=1 --no-same-owner || { rm -rf "$new"; return 1; }
  if [[ ! -f $new/BUILD_ID || ! -f $new/apps/server/dist/node/main.js ]]; then
    rm -rf "$new"
    return 1
  fi
  if [[ $smoke = 1 ]]; then
    if ! node "$new/apps/server/dist/node/main.js" self-check; then
      rm -rf "$new"
      return 1
    fi
  fi
  rm -rf "$target.prev"
  [[ -e $target ]] && mv "$target" "$target.prev"
  mv "$new" "$target"
}

hub_bootstrap() {
  [[ $CMD = node && ${NODE_ARGS[0]:-} = enroll ]] || die "hub package install is only for: bash -s -- node enroll --hub <url> --token <token>"
  local hub="" token="" allow_http=0 i a
  for ((i=0; i<${#NODE_ARGS[@]}; i++)); do
    a=${NODE_ARGS[i]}
    if [[ $a = --hub ]]; then hub=${NODE_ARGS[++i]:-}
    elif [[ $a = --token ]]; then token=${NODE_ARGS[++i]:-}
    elif [[ $a = --allow-http ]]; then allow_http=1
    fi
  done
  [[ -n $hub && -n $token ]] || die "usage: node enroll --hub <url> --token <token>"
  local curl_opts=(-sSL)
  case $hub in
    http://*)
      [[ $allow_http = 1 ]] || die "http:// hub refused without --allow-http — a MITM can edit this check when install.sh itself came over HTTP; the flag is a mistake-guard, not authenticity"
      ;;
    https://*) curl_opts+=(--proto-redir '=https') ;;
    *) die "hub URL must be http:// or https://" ;;
  esac
  have curl || die "curl is required for hub package install"
  have tar || die "tar is required for hub package install"
  have sha256sum || die "sha256sum is required for hub package install"
  local target="${TIERWYN_DIR:-$(home_dir -node)}"
  [[ -d $target/.git ]] && die "target $target is a git checkout"
  if [[ -e $target ]] && [[ -n $(ls -A "$target" 2>/dev/null) ]] && [[ ! -f $target/BUILD_ID ]]; then
    die "target $target is not empty and is not a package install (no BUILD_ID)"
  fi
  if [[ -z ${TIERWYN_NODE_REENROLL:-} ]]; then
    local ndir="${TIERWYN_NODE_DIR:-$CFG/node}"
    local unit="$UNIT_HOME/$(unit_name node).service"
    if [[ -f $ndir/node.json && -f $unit ]]; then
      local mainjs gitroot
      mainjs=$(awk '/^ExecStart=/{for(i=1;i<=NF;i++) if($i ~ /\/main\.js$/) print $i}' "$unit" | head -1)
      if [[ -n $mainjs ]]; then
        gitroot=$(cd "$(dirname "$mainjs")/../../../.." && pwd) || gitroot=""
        if [[ -d $gitroot/.git && ! -f $gitroot/BUILD_ID ]]; then
          die "already enrolled via git — run: tierwyn node update --from-hub"
        fi
      fi
    fi
  fi
  local tmp
  tmp=$(mktemp)
  local code=0
  code=$(curl "${curl_opts[@]}" -H "Authorization: Bearer $token" "$hub/node/package.tgz" -o "$tmp" -w '%{http_code}') || code=000
  if [[ $code = 401 ]]; then rm -f "$tmp"; die "enroll token invalid or expired"; fi
  if [[ $code != 200 ]]; then rm -f "$tmp"; die "package download failed (HTTP $code)"; fi
  echo "$TIERWYN_HUB_PKG_SHA256  $tmp" | sha256sum -c --quiet - || { rm -f "$tmp"; die "hub package changed — re-run the one-liner"; }
  pkg_swap "$tmp" "$target" || { rm -f "$tmp"; die "package extract failed"; }
  rm -f "$tmp"
  if [[ -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then
    bash "$target/scripts/install.sh" node setup </dev/tty
    exec bash "$target/scripts/install.sh" node "${NODE_ARGS[@]}" </dev/tty
  fi
  bash "$target/scripts/install.sh" --yes node setup
  exec bash "$target/scripts/install.sh" --yes node "${NODE_ARGS[@]}"
}

# ── release channels: stable = newest vX.Y.Z tag (default), edge = main tip ──
channel_get() {
  local c=${TIERWYN_CHANNEL:-}
  [[ -z $c && -f $CFG/channel ]] && c=$(<"$CFG/channel")
  [[ $c = edge ]] && echo edge || echo stable
}

latest_release_tag() { # $1 = repo; final releases only (no -rc)
  git -C "$1" tag -l 'v[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true
}

# git_sync <repo>: move the checkout to its channel's target. Non-zero = fetch/checkout failed.
# Stable never downgrades: forward-only DB migrations make an older tag unsafe, so a
# checkout ahead of the newest release (e.g. after edge) stays put until a tag includes it.
git_sync() { # $2 = fresh: just cloned, nothing built — take the tag without the ancestry guard
  local d=$1 fresh=${2:-} ch tag
  ch=$(channel_get)
  export GIT_TERMINAL_PROMPT=0 # private/unreachable remote fails fast instead of hanging
  if [[ $ch = edge ]]; then
    git -C "$d" fetch -q origin main || return 1
    if ! git -C "$d" symbolic-ref -q HEAD >/dev/null; then
      # Detached (stable tag): jump straight to origin/main so a stale local main can't
      # roll the checkout back; refuse if that would drop commits.
      if ! git -C "$d" merge-base --is-ancestor HEAD origin/main \
        || { git -C "$d" rev-parse -q --verify refs/heads/main >/dev/null \
             && ! git -C "$d" merge-base --is-ancestor main origin/main; }; then
        warn "edge: checkout or local main is not contained in origin/main — staying put"; return 1
      fi
      git -C "$d" checkout -q -B main origin/main || return 1
    fi
    git -C "$d" pull -q --ff-only || return 1
    ok "edge: main @ $(git -C "$d" rev-parse --short=8 HEAD)"
    return 0
  fi
  # Ancestry checks need history; pre-channel installs were --depth 1 clones.
  if [[ $(git -C "$d" rev-parse --is-shallow-repository 2>/dev/null) = true ]]; then
    git -C "$d" fetch -q --unshallow origin || return 1
  fi
  git -C "$d" fetch -q --force --tags origin || return 1 # --force: a re-pointed upstream tag must not wedge updates
  tag=$(latest_release_tag "$d")
  if [[ -n $tag ]] && ! git -C "$d" grep -q '^git_sync()' "$tag" -- scripts/install.sh 2>/dev/null; then
    tag="" # pre-channel release: its install.sh can't update a detached checkout
  fi
  if [[ -z $tag ]]; then
    warn "stable: no channel-aware release tag yet — staying on $(git -C "$d" rev-parse --short=8 HEAD)"
  elif [[ $(git -C "$d" rev-parse HEAD) = $(git -C "$d" rev-parse "$tag^{commit}") ]]; then
    ok "stable: $tag" # already there (keep the branch if on one)
  elif [[ $fresh = fresh ]] || git -C "$d" merge-base --is-ancestor HEAD "$tag"; then
    git -C "$d" -c advice.detachedHead=false checkout -q "$tag" || return 1
    ok "stable: $tag"
  else
    warn "stable: $(git -C "$d" rev-parse --short=8 HEAD) is ahead of $tag — staying put until a release includes it"
  fi
}

do_channel() {
  [[ -d $ROOT/.git ]] || die "channels apply to git installs — package nodes follow the hub's build"
  if [[ -n ${TARGET:-} ]]; then
    mkdir -p "$CFG"; echo "$TARGET" >"$CFG/channel"
    ok "channel → $TARGET"
    hint "apply it: tierwyn update   (on a node: tierwyn node update)"
  fi
  local at; at=$(git -C "$ROOT" describe --tags --exact-match HEAD 2>/dev/null || echo "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)@$(git -C "$ROOT" rev-parse --short=8 HEAD)")
  printf '  channel: %s%s\n  checkout: %s\n' "$(channel_get)" "$([[ -n ${TIERWYN_CHANNEL:-} ]] && echo ' (TIERWYN_CHANNEL)')" "$at"
}

# ── bootstrap: when piped from curl, clone then re-exec the clone's copy ──
SELF=$(readlink -f "${BASH_SOURCE[0]:-}" 2>/dev/null || true)
ROOT=""
if [[ -n $SELF && -f $SELF ]]; then
  ROOT=$(cd "$(dirname "$SELF")/.." && pwd)
  grep -qE '"name": "tierwyn"' "$ROOT/package.json" 2>/dev/null || ROOT=""
fi
if [[ -z $ROOT ]]; then
  # Read the rest of a piped script so curl exits cleanly instead of failing with
  # error 23 when we re-exec. Only safe inside this block: bash has already parsed
  # it, and every path through it re-execs or dies before needing later lines.
  if [[ -z ${BASH_SOURCE[0]:-} && -p /dev/stdin ]]; then cat >/dev/null; fi
  [[ -n $TIERWYN_HUB_PKG_SHA256 ]] && hub_bootstrap
  banner
  have git || die "git is required (e.g. sudo apt install git / sudo dnf install git)"
  INSTALL_DIR=${TIERWYN_DIR:-$(home_dir "")}
  [[ -f $INSTALL_DIR/BUILD_ID ]] && die "TIERWYN_DIR $INSTALL_DIR is a package install — not cloning over it"
  if [[ -n ${TIERWYN_CHANNEL:-} ]]; then mkdir -p "$CFG"; channel_get >"$CFG/channel"; fi
  fresh=""
  if [[ -d $INSTALL_DIR/.git ]]; then
    step "Updating existing clone at $INSTALL_DIR ($(channel_get))"
  else
    # blob:none: full commit history (tag ancestry checks) without every old blob.
    step "Cloning $REPO_URL → $INSTALL_DIR ($(channel_get))"; git clone -q --filter=blob:none "$REPO_URL" "$INSTALL_DIR"
    fresh=fresh
  fi
  git_sync "$INSTALL_DIR" $fresh || die "could not update $INSTALL_DIR to the $(channel_get) channel"
  # stdin is the curl pipe; hand the clone a real terminal if there is one.
  # `node` must re-exec as `node <NODE_ARGS>` — never ${CMD:-install}, which would
  # run hub setup. Remaining args (--hub, --token, URLs) live in NODE_ARGS.
  if [[ $CMD = node ]]; then
    # Always run the clone's `node setup` after clone/pull so enroll does not
    # skip a stale dist/node/main.js. Direct `tierwyn node enroll` in a checkout
    # still uses the missing-main.js shortcut below.
    if [[ -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then
      bash "$INSTALL_DIR/scripts/install.sh" node setup </dev/tty
      exec bash "$INSTALL_DIR/scripts/install.sh" node "${NODE_ARGS[@]}" </dev/tty
    fi
    bash "$INSTALL_DIR/scripts/install.sh" --yes node setup
    exec bash "$INSTALL_DIR/scripts/install.sh" --yes node "${NODE_ARGS[@]}"
  fi
  if [[ -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then
    exec bash "$INSTALL_DIR/scripts/install.sh" ${CMD:-install} "$@" </dev/tty
  fi
  exec bash "$INSTALL_DIR/scripts/install.sh" ${CMD:-install} --yes
fi
cd "$ROOT"
PACKAGED=0
[[ -f $ROOT/BUILD_ID ]] && PACKAGED=1
if (( PACKAGED )); then
  case ${CMD:-} in
    node|help|shim) ;;
    *) die "node-only package install — use tierwyn node …" ;;
  esac
fi
export PATH="$HOME/.local/bin:$PATH"
if [[ ! -e $HOME/.local/bin/tierwyn && ! -L $HOME/.local/bin/tierwyn ]]; then
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$SELF" "$HOME/.local/bin/tierwyn" 2>/dev/null || true
fi
# C37: an existing legacy alias keeps working but follows this install.

sync_node_path() {
  local dir="${TIERWYN_NODE_DIR:-$CFG/node}" f tmp
  mkdir -p "$dir"; chmod 700 "$dir"
  f="$dir/node.env"
  export_agent_path
  tmp=$(mktemp)
  ( umask 077; [[ -f $f ]] && grep -v '^PATH=' "$f" >"$tmp" || true; printf 'PATH=%s\n' "$PATH" >>"$tmp"; mv "$tmp" "$f" )
  chmod 600 "$f"
}

# True when node satisfies the floor AND is not an older 24.x (< 24.22.1) that openclaw rejects.
node_version_ok() {
  have node && node -e '
    const [maj, min, pat] = process.versions.node.split(".").map(Number);
    const minNode = Number(process.argv[1]) || 22;
    if (maj < minNode) process.exit(1);
    if (maj === 22 && min < 13) process.exit(1);
    if (maj === 23 && min < 4) process.exit(1);
    if (maj === 24 && (min < 22 || (min === 22 && pat < 1))) process.exit(1);
    process.exit(0);
  ' "${1:-$MIN_NODE}" 2>/dev/null
}
env_get() { [[ -r $1 ]] && sed -n "s/^$2=//p" "$1" | tail -1 | sed "s/^[\"']//; s/[\"']\$//"; return 0; }
env_files() {
  local f
  for f in "${TIERWYN_ENV_FILE:-}" "$ROOT/.env" "$CFG/prod.env" "$CFG/hub.env" /etc/tierwyn/prod.env; do
    [[ -n $f && -e $f ]] && echo "$f"
  done
  return 0
}
node_major() { have node && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Agent list (type, bin, hint, install cmd) comes from AGENT_BINARIES in discovery.ts — no drift.
agents_tsv() {
  node -e '
    const s = require("fs").readFileSync("apps/server/src/discovery.ts", "utf8");
    for (const m of s.matchAll(/[\x27]?([\w-]+)[\x27]?:\s*\{\s*bin:\s*\x27([^\x27]+)\x27,\s*hint:\s*\x27([^\x27]+)\x27(?:,\s*install:\s*\x27([^\x27]+)\x27)?(?:,\s*pkg:\s*\x27([^\x27]+)\x27)?/g))
      console.log([m[1], m[2], m[3], m[4] ?? "", m[5] ?? ""].join("\t"));'
}

# ── install steps ─────────────────────────────────────────────────────────
pkg_mgr() { local p; for p in apt-get dnf yum zypper pacman apk; do have "$p" && { echo "$p"; return 0; }; done; return 1; }
pkg_cmd() { # generic names (xz, build-essential, …) → distro install command; plain advice if no known manager
  local pm names=() p; pm=$(pkg_mgr) || { echo "install with your package manager: $*"; return 1; }
  for p; do
    case $p:$pm in
      xz:apt-get) names+=(xz-utils) ;;
      build-essential:apt-get) names+=(build-essential) ;;
      build-essential:pacman) names+=(base-devel) ;;
      build-essential:apk) names+=(build-base) ;;
      build-essential:*) names+=(gcc-c++ make) ;;
      *) names+=("$p") ;;
    esac
  done
  case $pm in
    apt-get|dnf|yum|zypper) echo "sudo $pm install -y ${names[*]}" ;;
    pacman) echo "sudo pacman -S --needed --noconfirm ${names[*]}" ;;
    apk) echo "sudo apk add ${names[*]}" ;;
  esac
}
pkg_install() { # best-effort system packages via the distro package manager
  local cmd; cmd=$(pkg_cmd "$@") || { warn "no known package manager — install manually: $*"; return 0; }
  if ask_yn "Missing packages:  $cmd\n\nInstall them now?" y; then eval "$cmd" || warn "package install failed"; fi
}

install_node() {
  local arch; case $(uname -m) in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) die "unsupported arch $(uname -m) — install Node $MIN_NODE+ manually";; esac
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" tmp; tmp=$(mktemp -d)
  local file; file=$(curl -fsSL "$base/SHASUMS256.txt" | tee "$tmp/SHASUMS256.txt" | awk "/linux-$arch\\.tar\\.xz\$/{print \$2}")
  [[ -n $file ]] || die "could not resolve Node $NODE_MAJOR tarball"
  step "Downloading $file (user-local, no sudo)"
  curl -fL --progress-bar "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "checksum mismatch for $file"
  mkdir -p "$HOME/.local/lib" "$HOME/.local/bin"
  rm -rf "$HOME/.local/lib"/node-v${NODE_MAJOR}.*-linux-"$arch" 2>/dev/null || true
  tar -xJf "$tmp/$file" -C "$HOME/.local/lib"
  local dir="$HOME/.local/lib/${file%.tar.xz}" b
  for b in node npm npx; do ln -sf "$dir/bin/$b" "$HOME/.local/bin/$b"; done
  rm -rf "$tmp"; hash -r
  export PATH="$HOME/.local/bin:$dir/bin:$PATH"
  # Keep agent CLIs in ~/.local/bin across Node tarball upgrades (default prefix is the versioned dir).
  npm config set prefix "$HOME/.local" >/dev/null
  ok "Node $(node -v) installed at $dir (symlinked into ~/.local/bin)"
  [[ :$PATH: == *":$HOME/.local/bin:"* ]] || hint "add ~/.local/bin to PATH in your shell profile"
}

bwrap_ok() { have bwrap && bwrap --ro-bind / / --unshare-pid true 2>/dev/null; }
# Ubuntu 24.04 restricts unprivileged userns and (unlike 26.04's apparmor 5) ships no bwrap profile.
bwrap_apparmor_blocked() {
  [[ $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null) = 1 && -d /etc/apparmor.d ]] && have apparmor_parser
}
# Mirrors 26.04's bwrap-userns-restrict: bwrap itself may set up namespaces, but everything it
# runs lands in unpriv_bwrap with every capability denied, so bwrap can't be used to get a
# capable userns (the hole the global restriction closes). Cost: no nested bwrap — same as 26.04.
bwrap_profile() { # $1 = resolved bwrap path
  local body='allow file rwlkm /{**,},
  allow network,
  allow unix,
  allow ptrace,
  allow signal,
  allow mqueue,
  allow io_uring,
  allow userns,
  allow mount,
  allow umount,
  allow pivot_root,
  allow dbus,'
  printf 'abi <abi/4.0>,\ninclude <tunables/global>\n'
  printf 'profile bwrap %s flags=(attach_disconnected,mediate_deleted) {\n  allow capability,\n  %s\n  allow pix /** -> &bwrap//&unpriv_bwrap,\n  include if exists <local/bwrap>\n}\n' "$1" "$body"
  printf 'profile unpriv_bwrap flags=(attach_disconnected,mediate_deleted) {\n  %s\n  allow pix /** -> &unpriv_bwrap,\n  audit deny capability,\n  include if exists <local/unpriv_bwrap>\n}\n' "$body"
}
bwrap_profile_write() {
  local bin sn=""; bin=$(readlink -f "$(command -v bwrap)")
  (( ${YES:-0} )) && sn=-n # headless: fail fast instead of hanging on a password prompt
  bwrap_profile "$bin" | sudo $sn tee /etc/apparmor.d/tierwyn-bwrap >/dev/null \
    && sudo $sn apparmor_parser -r /etc/apparmor.d/tierwyn-bwrap
}
ensure_bwrap() { # check, and offer the fix — called from every setup path; never fatal (sandbox is optional)
  if ! have bwrap; then
    warn "bwrap not found — agent sandbox unavailable"
    # Default yes: without bwrap any sandbox-on setting fails. One prompt (pkg_install would ask again).
    pkg_mgr >/dev/null && ask_yn "Install bubblewrap (needed for the per-agent sandbox)?" y \
      && { eval "$(pkg_cmd bubblewrap)" || warn "bubblewrap install failed"; }
    have bwrap || { hint "$(pkg_cmd bubblewrap)"; return 0; }
  fi
  # Pre-0.1.3 installs wrote an unconfined profile; swap it for the capability-dropping one.
  if [[ -f /etc/apparmor.d/tierwyn-bwrap ]] && ! grep -q unpriv_bwrap /etc/apparmor.d/tierwyn-bwrap; then
    if ask_yn "Tighten /etc/apparmor.d/tierwyn-bwrap (drop capabilities inside bwrap, needs sudo)?" y \
       && bwrap_profile_write; then ok "AppArmor bwrap profile tightened"
    else warn "left the old unconfined bwrap profile in place"; fi
  fi
  bwrap_ok && { ok "bwrap (namespaces OK)"; return 0; }
  warn "bwrap present but user namespaces blocked — agent sandbox unavailable"
  if bwrap_apparmor_blocked; then
    if ask_yn "AppArmor blocks user namespaces (kernel.apparmor_restrict_unprivileged_userns=1).\n\nAllow them for bwrap only (writes /etc/apparmor.d/tierwyn-bwrap, needs sudo)?" y \
       && bwrap_profile_write && bwrap_ok; then ok "bwrap (namespaces OK, AppArmor profile installed)"
    else hint "allow bwrap in AppArmor: re-run 'tierwyn setup', or see docs/architecture/sandbox.md"; fi
  else hint "check that unprivileged user namespaces are enabled (sysctl user.max_user_namespaces)"; fi
}

do_prereqs() {
  step "System prerequisites"
  . /etc/os-release 2>/dev/null && ok "OS: ${PRETTY_NAME:-unknown} ($(uname -m))"
  local missing=() t
  for t in git curl tar xz unzip; do have $t && ok "$t" || missing+=("$t"); done
  [[ ${#missing[@]} = 0 ]] || pkg_install "${missing[@]}"
  # argon2 + better-sqlite3 normally use prebuilt binaries; a compiler is the fallback.
  if have make && have g++ && have python3; then ok "build toolchain (make, g++, python3)"
  else warn "no C++ toolchain — fine unless native prebuilds are unavailable for your platform"
       pkg_mgr >/dev/null && ask_yn "Install a C++ toolchain + python3 as a fallback for native modules?" n && pkg_install build-essential python3; fi
  ensure_bwrap

  local m; m=$(node_major)
  if (( m >= NODE_MAJOR )) && node_version_ok "$NODE_MAJOR"; then ok "Node $(node -v)"
  else
    [[ $m = 0 ]] && warn "Node.js not found" || warn "Node $(node -v) is older than recommended $NODE_MAJOR (or <24.22.1; floor 22.13)"
    ask_yn "Install Node $NODE_MAJOR into ~/.local (official tarball, checksum-verified)?" y && install_node
    node_version_ok "$MIN_NODE" || die "Node 22.13+ is required"
  fi
  export_agent_path
  if have npm; then
    local prefix; prefix=$(npm prefix -g)
    if [[ $prefix == "$HOME/.local/lib/node-"* ]]; then
      npm config set prefix "$HOME/.local" >/dev/null
      ok "npm global prefix → ~/.local"
    fi
  fi
}

do_build() {
  local no_pull=0
  [[ ${1:-} = --no-pull ]] && no_pull=1
  step "Dependencies + build"
  if (( ! no_pull )) && [[ -d .git ]] && { [[ ${CMD:-} = update ]] || ask_yn "Update the checkout ($(channel_get) channel)?" n; }; then
    git_sync "$ROOT" || warn "update failed (no access, or local changes?) — continuing with current checkout"
  fi
  # npm ci empties node_modules first — through a symlink that wipes the target (e.g. a live install).
  [[ -L node_modules ]] && die "node_modules is a symlink — refusing npm ci (it would wipe $(readlink -f node_modules))"
  npm ci --no-audit --no-fund || {
    bad "npm ci failed"
    # The usual cause on a fresh box: a native module had no prebuilt binary and no compiler to fall back on.
    have g++ || hint "no C++ toolchain to compile native modules — $(pkg_cmd build-essential python3), then re-run"
    return 1
  }
  npm run build --workspace=packages/shared
  npm run build
  ok "build complete ($(git rev-parse --short=8 HEAD 2>/dev/null || echo no-git))"
}

write_env() { # write_env path mode
  local f=$1 mode=$2 port db secret hash="" pw pw2 cookie=true auth=""
  if [[ -e $f ]] && ! ask_yn "$f already exists. Overwrite it?" n; then ok "keeping $f"; return; fi
  if [[ $mode = dev ]]; then port=8787; db=./data/tierwyn.db; cookie=false; auth=true
  else
    port=$(ask "API port" 8788); db="$ROOT/data/$mode.db"
    case ${TIERWYN_COOKIE_SECURE:-} in
      true|1) cookie=true ;;
      false|0) cookie=false ;;
      *) # Explicit 2-way choice: a Y default here silently broke plain-HTTP LAN logins (Secure cookie dropped).
        # --yes keeps the old secure default; interactive Enter-through lands on HTTP, which works either way.
        [[ $(menu "How will browsers open Tierwyn?" "$([[ $YES = 1 ]] && echo https || echo http)" \
          http  "HTTP: direct LAN/IP, e.g. http://192.168.x.x:4173 (COOKIE_SECURE=false)" \
          https "HTTPS: behind a TLS reverse proxy, e.g. https://tierwyn.example.com (COOKIE_SECURE=true)") = http ]] && cookie=false ;;
    esac
    if [[ $YES = 1 ]]; then
      pw=${TIERWYN_OPERATOR_PASSWORD:-}
      unset TIERWYN_OPERATOR_PASSWORD
      [[ ${#pw} -ge 12 ]] || die "hub/prod --yes needs TIERWYN_OPERATOR_PASSWORD (≥12 chars) — or run interactively"
    else
      while :; do
        pw=$(ask_secret "Operator password (min 12 chars):"); pw2=$(ask_secret "Repeat password:")
        [[ $pw = "$pw2" && ${#pw} -ge 12 ]] && break; warn "passwords differ or too short"
      done
    fi
    INSTALL_PW=$pw
    hash=$(printf %s "$pw" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>require("argon2").hash(d).then(h=>console.log(h)))')
  fi
  secret=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')
  mkdir -p "$(dirname "$f")"; ( umask 077; {
    echo "# Generated by tierwyn on $(date -Is) — see .env.example for every option"
    echo "HOST=127.0.0.1"
    echo "PORT=$port"
    echo "TIERWYN_DB=$db"
    echo "SESSION_SECRET=$secret"
    [[ -n $hash ]] && echo "OPERATOR_PASSWORD_HASH=$hash"
    echo "COOKIE_SECURE=$cookie"
    [[ -n $auth ]] && printf '# local dev only — never with LAN exposure\nAUTH_DISABLED=true\n'
    # Dedicated hub: sandbox defaults on (until saved in Settings → Sandbox) and projects
    # may not overlap this checkout. Never written for dev/prod — a dev box keeps a writable repo.
    [[ $mode = hub ]] && printf '# dedicated hub user — sandbox-on default, no project over the hub tree\nTIERWYN_DEDICATED_HUB=1\n'
    # systemd user units don't inherit the shell PATH; agents need it (spawn ENOENT otherwise).
    if [[ $mode != dev ]]; then export_agent_path; echo "PATH=$PATH"; fi
  } >"$f" )
  ok "wrote $f (mode 600)"
}

# ── TIERWYN_ALLOWED_HOSTS (prod-web Vite Host check) ───────────────────────
# Existing installs predate Environment=TIERWYN_ALLOWED_HOSTS on the unit.
# tierwyn update does not re-render units, so a reverse-proxied domain would
# get Vite 403 after the gating change. Backfill on update; keep a narrowed
# value on re-render; doctor accepts EnvironmentFile as well as Environment=.

web_unit_allowed_hosts_value() { # unit-file → value of Environment=TIERWYN_ALLOWED_HOSTS (empty if none)
  local f=$1
  [[ -f $f ]] || return 0
  awk '
    /^[[:space:]]*#/ { next }
    match($0, /^Environment=.*TIERWYN_ALLOWED_HOSTS=/) {
      line = $0
      sub(/^.*TIERWYN_ALLOWED_HOSTS=/, "", line)
      gsub(/^["'\'']+|["'\'']+$/, "", line)
      sub(/[[:space:]].*$/, "", line)
      val = line
    }
    END { printf "%s", val }
  ' "$f"
}

web_unit_env_files() { # unit-file → EnvironmentFile= paths, one per line
  local f=$1 line p
  [[ -f $f ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    case $line in
      \#*|\;*) continue ;;
      EnvironmentFile=*)
        p=${line#EnvironmentFile=}
        p=${p#\"}; p=${p%\"}
        p=${p#\'}; p=${p%\'}
        p=${p#-}
        p=${p//%h/$HOME}
        [[ -n $p ]] && printf '%s\n' "$p"
        ;;
    esac
  done < "$f"
}

# 0 = set (unit Environment= or a readable env file)
# 1 = unset
# 2 = unset on the unit, and at least one listed env file exists but is unreadable
web_unit_allowed_hosts_state() { # unit-file
  local f=$1 p unreadable=0
  [[ -f $f ]] || return 1
  if grep -qE '^[[:space:]]*Environment=["'"'"']?([^#]*[[:space:]])?TIERWYN_ALLOWED_HOSTS=' "$f"; then
    return 0
  fi
  while IFS= read -r p; do
    [[ -n $p ]] || continue
    [[ -e $p ]] || continue
    if [[ ! -r $p ]]; then unreadable=1; continue; fi
    grep -qE '^[[:space:]]*TIERWYN_ALLOWED_HOSTS=' "$p" && return 0
  done < <(web_unit_env_files "$f")
  (( unreadable )) && return 2
  return 1
}

ensure_prod_web_allowed_hosts() { # [unit-file] — idempotent backfill for existing installs
  local unit=${1:-$UNIT_HOME/$(web_unit).service} st=0 tmp
  [[ -f $unit ]] || return 0
  web_unit_allowed_hosts_state "$unit" || st=$?
  # Already set, or an env file we cannot read (do not override a possible narrowed value).
  (( st == 0 || st == 2 )) && return 0
  tmp=$(mktemp)
  awk '
    BEGIN { added = 0 }
    /^\[/ {
      if (section == "Service" && !added) {
        print "# Vite Host-header check (DNS-rebinding). `true` allows any Host so a"
        print "# reverse-proxied domain keeps working. Narrow to your public hostname"
        print "# when you can, e.g. Environment=TIERWYN_ALLOWED_HOSTS=tierwyn.example.com"
        print "Environment=TIERWYN_ALLOWED_HOSTS=true"
        print ""
        added = 1
      }
      section = substr($0, 2, length($0) - 2)
    }
    { print }
    END {
      if (!added && section == "Service") {
        print "# Vite Host-header check (DNS-rebinding). `true` allows any Host so a"
        print "# reverse-proxied domain keeps working. Narrow to your public hostname"
        print "# when you can, e.g. Environment=TIERWYN_ALLOWED_HOSTS=tierwyn.example.com"
        print "Environment=TIERWYN_ALLOWED_HOSTS=true"
      }
    }
  ' "$unit" >"$tmp"
  cat "$tmp" >"$unit"
  rm -f "$tmp"
  printf '  %s+%s added Environment=TIERWYN_ALLOWED_HOSTS=true to %s — narrow to your hostname when you can\n' "$C" "$N" "$(basename "$unit" .service)"
  have systemctl && systemctl --user daemon-reload
  return 0
}

env_pair() { [[ $(basename "${1:-}") = hub.env ]] && echo hub || echo prod; } # envfile → pair base

render_prod_units() { # envfile [unit-dir] — re-render the API + web pair (prod or hub, from the env file name); keep TIERWYN_ALLOWED_HOSTS
  local envf=$1 udir=${2:-$HOME/.config/systemd/user} port b u web_unit keep_hosts="" base
  base=$(env_pair "$envf")
  port=$(env_get "$envf" PORT); port=${port:-8788}
  mkdir -p "$udir"
  web_unit="$udir/$(web_unit "$base").service"
  [[ -f $web_unit ]] && keep_hosts=$(web_unit_allowed_hosts_value "$web_unit")
  for b in prod prod-web; do
    u=$(unit_name "${b/prod/$base}")
    # ponytail: sed over the shipped templates; switch to a real template var if they grow more host paths.
    # The hub pair is the prod template renamed — same process, different unit names + env file.
    sed -e "s#%h/Projects/Tierwyn#$ROOT#g" \
        -e "s#%h/.local/bin/node#$(command -v node)#g" \
        -e "s#%h/.local/bin/npm#$(command -v npm)#g" \
        -e "s#/etc/tierwyn/prod.env#$envf#g" \
        -e "s#tierwyn-prod\.service#$(api_unit "$base").service#g" \
        -e "s#Tierwyn prod #Tierwyn $base #g" \
        -e "s#127.0.0.1:8788#127.0.0.1:$port#g" \
        "$ROOT/docs/deploy/systemd/tierwyn-$b.service" >"$udir/$u.service"
  done
  if [[ -n $keep_hosts && $keep_hosts =~ ^[A-Za-z0-9._:,*-]+$ ]]; then
    sed -E -i "s#^Environment=TIERWYN_ALLOWED_HOSTS=.*#Environment=TIERWYN_ALLOWED_HOSTS=$keep_hosts#" "$web_unit"
  fi
}

doctor_web_allowed_hosts() {
  local wu; wu=$(web_unit)
  local web_unit="$UNIT_HOME/$wu.service" st=0
  [[ -f $web_unit ]] || return 0
  web_unit_allowed_hosts_state "$web_unit" || st=$?
  case $st in
    0) ok "$wu: TIERWYN_ALLOWED_HOSTS set" ;;
    2) printf '  %s· %s: could not verify TIERWYN_ALLOWED_HOSTS (env file unreadable)%s\n' "$D" "$wu" "$N"
       hint "check EnvironmentFile= in $web_unit is readable by $USER" ;;
    *) warn "$wu has no TIERWYN_ALLOWED_HOSTS — Vite will reject the proxied Host header"
       hint "add Environment=TIERWYN_ALLOWED_HOSTS=true (or your domain) to $web_unit, then systemctl --user daemon-reload" ;;
  esac
}

do_services() {
  have systemctl && systemctl --user show-environment >/dev/null 2>&1 || { warn "systemd user session unavailable — run 'node apps/server/dist/index.js' yourself"; return 0; }
  local envf=${1:-$(pair_env)} port udir="$HOME/.config/systemd/user" base
  [[ -e $envf ]] || envf=$(env_files | grep -m1 -E '(prod|hub)\.env$' || true)
  [[ -n $envf ]] || { bad "no prod/hub env file found — run install in prod or hub mode first"; return 0; }
  base=$(env_pair "$envf")
  port=$(env_get "$envf" PORT); port=${port:-8788}
  step "systemd user units (env: $envf, API :$port, web :4173)"
  # Re-render from templates, but keep an operator-narrowed TIERWYN_ALLOWED_HOSTS.
  render_prod_units "$envf" "$udir"
  systemctl --user daemon-reload
  if ask_yn "Enable and (re)start $(api_unit "$base") + $(web_unit "$base") now?" y; then
    systemctl --user enable "$(api_unit "$base")" "$(web_unit "$base")" >/dev/null 2>&1
    systemctl --user restart "$(api_unit "$base")" "$(web_unit "$base")" && ok "services started"
  fi
  [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) = yes ]] \
    || hint "run 'sudo loginctl enable-linger $USER' so services survive logout/reboot"
}

do_agents() {
  step "Agent CLIs"
  local t bin h inst _pkg installed=() missing=() args=()
  while IFS=$'\t' read -r t bin h inst _pkg; do
    if have "$bin" || [[ $bin == /* && -e $bin ]]; then ok "$t ($bin)"; installed+=("$t"); continue; fi
    if [[ -n $inst ]]; then missing+=("$t"); args+=("$t" "$inst" off)
    else printf '  %s· %s not installed — %s%s\n' "$D" "$t" "${h#*— }" "$N"; fi
  done < <(agents_tsv)

  # 1. Install — strictly on request, nothing pre-selected.
  if (( ${#missing[@]} )) && ask_yn "${#missing[@]} agent CLIs can be installed automatically.\n\nChoose some to install now?" n; then
    local sel; sel=$(checklist "Install which agents? (space toggles — each runs the command shown)" "${args[@]}")
    [[ -n ${sel// } ]] && agents_install $sel
  fi

  # 2. Enable in Tierwyn — only with approval, only what the operator ticks.
  any_agent_installed || { hint "no agent CLI installed yet — run 'tierwyn agents' later, or install them from ⚙ Settings → Agents in the web UI"; return 0; }
  ask_yn "You choose which; you can change this later in ⚙ Settings → Agents.\n\nEnable detected agents in Tierwyn now?" y || return 0
  hub_connect || { hint "enable agents later in ⚙ Settings → Agents"; return 0; }
  agents_enable
  hub_disconnect
}

agents_install() { # agent types…
  local t bin h inst _pkg cmds=() scripts=() todo=" $* "
  while IFS=$'\t' read -r t bin h inst _pkg; do
    [[ $todo == *" $t "* && -n $inst ]] || continue
    cmds+=("$t"$'\t'"$inst"); [[ $inst == curl* ]] && scripts+=("  $t: $inst")
  done < <(agents_tsv)
  if (( ${#scripts[@]} )) && ! ask_yn "These run the vendor's own install script from the internet:\n\n$(printf '%s\n' "${scripts[@]}")\n\nContinue?" y; then
    return 0
  fi
  npm_writable_prefix
  local line
  for line in "${cmds[@]}"; do
    t=${line%%$'\t'*}; inst=${line#*$'\t'}
    [[ $t = kiro ]] && ! have unzip && pkg_install unzip
    step "Installing $t"; printf '  %s$ %s%s\n' "$D" "$inst" "$N"
    # Commands come only from AGENT_BINARIES.install, whose shape is pinned by discovery.test.ts.
    if bash -c "set -o pipefail; $inst"; then ok "$t installed"; else bad "$t install failed"; fi
  done
  # Vendor scripts drop binaries in assorted user dirs; pick them up for detection in this run.
  export_agent_path; hash -r
  sync_prod_path "${KAPI_ENV:-$(pair_env)}"
  if have systemctl && systemctl --user is-active --quiet "$(api_unit)" 2>/dev/null; then
    systemctl --user daemon-reload
    systemctl --user restart "$(api_unit)"
    local port f=${KAPI_ENV:-$(pair_env)}
    port=$(env_get "$f" PORT); port=${port:-8788}
    wait_http "http://127.0.0.1:$port/health" 60 "Tierwyn (PATH refresh)" || true
  fi
  for line in "${cmds[@]}"; do
    t=${line%%$'\t'*}; bin=$(agents_tsv | awk -F'\t' -v t="$t" '$1==t{print $2}')
    have "$bin" || { warn "$t: '$bin' still not on PATH"; hint "open a new shell, or add its install dir to PATH"; }
  done
  hint "each agent needs a one-time sign-in in its own CLI (e.g. claude, copilot login, codex login)"
}

# ── Tierwyn API (agent enabling goes through the same PATCH /agents/:id the UI uses) ──
KAPI_BASE=""; KAPI_COOKIE=""; KAPI_TMP_PID=""; KAPI_ENV=""; INSTALL_PW=""
hub_connect() {
  local f=${KAPI_ENV:-} c
  if [[ -z $f ]]; then for c in "${TIERWYN_ENV_FILE:-}" "$(pair_env)" "$CFG/prod.env" "$CFG/hub.env" /etc/tierwyn/prod.env "$ROOT/.env"; do
    [[ -n $c && -r $c ]] && { f=$c; break; }; done; fi
  [[ -n $f ]] || { warn "no Tierwyn env file found — run install first"; return 1; }
  local port; port=$(env_get "$f" PORT); port=${port:-8787}; KAPI_BASE="http://127.0.0.1:$port"
  step "Connecting to Tierwyn on :$port ($f)"
  if ! curl -fsS -m 3 "$KAPI_BASE/health" >/dev/null 2>&1; then
    if [[ $f != "$ROOT/.env" ]]; then warn "Tierwyn is not running on :$port"; hint "start it (tierwyn services), then: tierwyn agents"; return 1; fi
    ask_yn "Tierwyn isn't running. A first boot can take about a minute.\n\nStart it temporarily to apply this?" y || return 1
    # Drop every inherited TIERWYN_*/PORT/HOST: when this runs under a live Tierwyn, the parent's
    # TIERWYN_DB would otherwise win over .env (dotenv never overrides) and open the live DB.
    local v unset=()
    for v in $(compgen -e); do [[ $v == TIERWYN_* || $v == PORT || $v == HOST ]] && unset+=(-u "$v"); done
    mkdir -p "$ROOT/data"
    env "${unset[@]}" TIERWYN_GROKBOT_WATCH=0 TIERWYN_GROKBOT_AUTOSTART=0 \
      node apps/server/dist/index.js >"$ROOT/data/.install-boot.log" 2>&1 &
    KAPI_TMP_PID=$!
    wait_http "$KAPI_BASE/health" 180 "Tierwyn (temporary)" || { hint "log: $ROOT/data/.install-boot.log"; hub_disconnect; return 1; }
  fi
  if [[ $(env_get "$f" AUTH_DISABLED) != true ]]; then
    local pw=${INSTALL_PW:-}; [[ -n $pw ]] || pw=$(ask_secret "Tierwyn operator password:")
    [[ -n $pw ]] || { warn "operator password needed to enable agents — run interactively"; hub_disconnect; return 1; }
    # Password travels on stdin only (never argv). One attempt: /auth/login is rate-limited.
    KAPI_COOKIE=$(printf %s "$pw" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify({password:d})))' \
      | curl -sS -m 10 -D - -o /dev/null -H 'Content-Type: application/json' --data-binary @- "$KAPI_BASE/auth/login" \
      | sed -n 's/^[Ss]et-[Cc]ookie: *\([^;]*\).*/\1/p' | head -1)
    [[ -n $KAPI_COOKIE ]] || { bad "login failed (wrong password?)"; hub_disconnect; return 1; }
  fi
  ok "connected"
}

kapi() { # kapi METHOD PATH [json] → sets KAPI_CODE + KAPI_BODY (no subshell, so both survive)
  local out; out=$(mktemp)
  KAPI_CODE=$(curl -sS -m 30 -o "$out" -w '%{http_code}' -X "$1" -H 'Content-Type: application/json' \
    ${KAPI_COOKIE:+-H "Cookie: $KAPI_COOKIE"} ${3:+--data "$3"} "$KAPI_BASE$2" 2>/dev/null) || KAPI_CODE=000
  KAPI_BODY=$(<"$out"); rm -f "$out"
}

agents_enable() {
  kapi GET /agents; local body=$KAPI_BODY
  [[ $KAPI_CODE = 200 ]] || { bad "GET /agents → HTTP $KAPI_CODE"; return 0; }
  # id \t enabled \t installed — installed is Tierwyn's own PATH view, i.e. what it will accept.
  local rows; rows=$(node -e 'for (const a of JSON.parse(require("fs").readFileSync(0,"utf8")).agents) console.log([a.id,a.enabled,a.installed].join("\t"))' <<<"$body")
  local id en inst args=() n=0 t bin
  while IFS=$'\t' read -r id en inst; do
    if [[ $en = true ]]; then ok "$id already enabled"
    elif [[ $inst = true ]]; then args+=("$id" "installed — enable in Tierwyn" on); n=$((n+1))
    else
      bin=$(agents_tsv | awk -F'\t' -v t="$id" '$1==t{print $2}')
      if [[ -n $bin ]] && have "$bin"; then warn "$id: installed, but Tierwyn can't see '$bin' on its PATH"; hint "add $(dirname "$(command -v "$bin")") to PATH= in the env file and restart Tierwyn"; fi
    fi
  done <<<"$rows"
  (( n )) || { hint "nothing new to enable"; return 0; }
  local sel; sel=$(checklist "Enable which agents in Tierwyn? (pre-selected = detected; space toggles)" "${args[@]}")
  for id in $sel; do
    kapi PATCH "/agents/$id" '{"enabled":true}'
    case $KAPI_CODE in 200) ok "enabled $id" ;; 400) warn "$id: Tierwyn reports it is not installed on its PATH" ;; *) bad "$id: HTTP $KAPI_CODE" ;; esac
  done
}

hub_disconnect() {
  [[ -n $KAPI_TMP_PID ]] || return 0
  kill "$KAPI_TMP_PID" 2>/dev/null; wait "$KAPI_TMP_PID" 2>/dev/null || true
  KAPI_TMP_PID=""; ok "temporary Tierwyn stopped"
}

do_config() {
  step "Configuration"
  local mode
  mode=$(menu "How will you run Tierwyn?" "${MODE:-dev}" \
    dev  "Development — localhost only, auth disabled, npm run dev" \
    prod "Production on a dev box — password login, tierwyn-prod* units; agents may edit this checkout" \
    hub  "Dedicated hub — this Unix user only runs Tierwyn; sandbox on, tierwyn-hub* units") || return 1
  MODE=$mode
  if [[ $mode = dev ]]; then write_env "$ROOT/.env" dev; KAPI_ENV="$ROOT/.env"
  else
    [[ $mode = hub ]] && hub_preflight
    write_env "$CFG/$mode.env" "$mode"; KAPI_ENV="$CFG/$mode.env"; do_services "$KAPI_ENV"
  fi
  if [[ ${CMD:-} = config ]] && unit_installed "$(api_unit)"; then
    hint "restart after changes: tierwyn restart"
  fi
}

# Dedicated hub: the protection is bwrap (hub tree, config, CLIs read-only to agents).
# Without working user namespaces the sandbox silently resolves to off — say so loudly.
hub_preflight() {
  step "Dedicated hub checks"
  if unit_installed tierwyn-prod; then
    warn "tierwyn-prod units exist for $USER — this looks like a dev/prod box, not a dedicated hub user"
    hint "a dedicated hub is a separate Unix user (e.g. sudo useradd -m tierhost) running its own clone"
  fi
  # Prerequisites (step 1) already offered the bwrap / AppArmor fix.
  bwrap_ok && ok "bwrap (namespaces OK) — agents will run sandboxed by default" \
    || { warn "bwrap missing or user namespaces blocked — the hub sandbox default cannot take effect"; hint "re-run 'tierwyn setup' (Prerequisites offers the fix)"; }
  hint "do not create a project at $ROOT (or above it) — the hub refuses it; agents' cwd is writable"
}

# `npm i -g` into a root-owned prefix fails EACCES. Point npm at ~/.npm-global for this
# process only (env, never `npm config set`). Same rule as withWritableNpmPrefix() in
# apps/server/src/node/install.ts (UI Install / Install-all / node agents.install).
# No early return on an env prefix: `npx tierwyn` exports npm_config_prefix=/usr itself.
# `npm prefix -g` honours the env, so a writable user-chosen prefix is still kept.
npm_writable_prefix() {
  have npm || return 0
  local p d; p=$(npm prefix -g 2>/dev/null) || p=""
  d="$p/lib/node_modules"; [[ -d $d ]] || d="$p/lib"
  [[ -n $p && -w $d ]] && return 0
  unset NPM_CONFIG_PREFIX
  export npm_config_prefix="$HOME/.npm-global"
  mkdir -p "$npm_config_prefix/bin" "$npm_config_prefix/lib"
  hint "npm global prefix ${p:-?} not writable — installing into ~/.npm-global (on Tierwyn's PATH)"
}

ensure_shell_path() {
  local dir="$HOME/.local/bin"
  mkdir -p "$dir"
  export PATH="$dir:$PATH"

  local found=0
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    if [[ -f $rc ]] && grep -Eq '\.local/bin' "$rc" 2>/dev/null; then
      found=1
      break
    fi
  done

  if (( ! found )); then
    local target="$HOME/.bashrc"
    if [[ ${SHELL:-} == */zsh && -f $HOME/.zshrc ]]; then
      target="$HOME/.zshrc"
    elif [[ ! -f $HOME/.bashrc && -f $HOME/.profile ]]; then
      target="$HOME/.profile"
    fi

    if [[ -f $target ]]; then
      printf '\n# Added by Tierwyn installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$target"
      ok "Added ~/.local/bin to PATH in $target"
      hint "Open a new terminal or run: source $target"
    fi
  fi
}

install_shim() {
  step "CLI shim (tierwyn command)"
  local dest="$HOME/.local/bin/tierwyn"
  mkdir -p "$HOME/.local/bin"
  local linked=0

  if [[ -L $dest ]]; then
    local tgt; tgt=$(readlink -f "$dest" 2>/dev/null || true)
    if [[ $tgt = "$SELF" ]]; then
      ok "tierwyn shim present ($dest → $SELF)"
      linked=1
    else
      local checkout; checkout=$(cd "$(dirname "$tgt")/.." && pwd 2>/dev/null || true)
      if [[ -n $checkout && -f $checkout/package.json ]] && grep -qE '"name": "tierwyn"' "$checkout/package.json" 2>/dev/null; then
        ln -sfn "$SELF" "$dest"
        ok "tierwyn updated → $SELF"
        linked=1
      else
        warn "$dest exists and points to $tgt (not this checkout)"
        hint "left it alone; to overwrite: ln -sfn $SELF $dest"
      fi
    fi
  elif [[ -e $dest ]]; then
    warn "$dest exists and is not a symlink"
    hint "left it alone"
  else
    ln -sfn "$SELF" "$dest"
    ok "Installed tierwyn command to $dest"
    linked=1
  fi

  if (( linked )); then
        ensure_shell_path
    if [[ -w /usr/local/bin ]]; then
      ln -sfn "$dest" /usr/local/bin/tierwyn 2>/dev/null || true
    elif have sudo && sudo -n true 2>/dev/null; then
      sudo -n ln -sfn "$dest" /usr/local/bin/tierwyn 2>/dev/null || true
    fi
    if have tierwyn; then
      ok "tierwyn on PATH ($(command -v tierwyn))"
      hint "'tierwyn' opens the menu; 'tierwyn <cmd>' runs subcommands"
    else
      hint "Run 'source ~/.bashrc' or restart shell to use 'tierwyn' directly"
    fi
  fi
}

do_install() {
  TO_MENU=0
  if phase 1 "Prerequisites" "check git, Node, build tools"; then do_prereqs; fi
  install_shim
  if phase 2 "Build" "npm ci + build all workspaces"; then do_build; fi
  if phase 3 "Configure" "choose dev or prod, port, password"; then do_config; fi
  if phase 4 "Agents" "install / enable agent CLIs"; then do_agents; fi
  if phase 5 "Sidecars" "Piper / Kokoro TTS, Whisper STT, Grok Bot (optional)"; then do_sidecars; fi
  if phase 6 "Health check" "run diagnostics"; then do_doctor || true; fi
  (( TO_MENU )) && return 0
  printf '\n%s◇%s  Setup finished\n' "$G" "$N"
  [[ ${MODE:-} = prod ]] && hint "put a TLS reverse proxy in front — docs/deploy/deployment.md"
  hint "plugins: none bundled — import a .tar.gz in Settings → Plugins (docs/architecture/plugins.md)"
  hint "'tierwyn' opens the home menu any time"
}

# ── sidecars (optional, each independent; runbook: docs/deploy/operator-sidecars.md) ──
UNIT_DIR="$HOME/.config/systemd/user"
need_user_systemd() { have systemctl && systemctl --user show-environment >/dev/null 2>&1 || { bad "systemd user session unavailable"; return 1; }; }
unit_active() { systemctl --user is-active --quiet "$1" 2>/dev/null; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_http() { # wait_http url seconds label
  local i; printf '  waiting for %s ' "$3"
  for ((i = 0; i < $2; i += 3)); do curl -fsS -m 3 "$1" >/dev/null 2>&1 && { echo; ok "$3 answering"; return 0; }; printf .; sleep 3; done
  echo; warn "$3 not answering after $2 s"; return 1
}
start_unit() { # start_unit name — enable + (re)start, asking before bouncing a live one
  systemctl --user daemon-reload
  if unit_active "$1" && ! ask_yn "$1 is already running. Restart it with the new files?" y; then return 0; fi
  systemctl --user enable "$1" >/dev/null 2>&1
  systemctl --user restart "$1" && ok "$1 started" || { bad "$1 failed to start"; hint "journalctl --user -u $1 -n 50"; }
}

sidecar_piper() {
  step "Piper TTS (127.0.0.1:5000)"
  need_user_systemd || return 0
  have python3 || pkg_install python3
  python3 -c 'import venv, ensurepip' 2>/dev/null || { have apt-get && pkg_install python3-venv; }
  if port_open 5000 && ! unit_active $(unit_name piper); then
    warn "port 5000 is taken by something else"; hint "legacy one-voice server? pkill -f piper.http_server"; return 0
  fi
  local venv="$HOME/piper-venv" voices="$HOME/piper-voices"
  [[ -x $venv/bin/python ]] || python3 -m venv "$venv" || { bad "venv creation failed"; return 0; }
  "$venv/bin/pip" install -q --upgrade pip piper-tts flask && ok "venv $venv (piper-tts, flask)" || { bad "pip install failed"; return 0; }
  mkdir -p "$HOME/tierwyn-piper" "$voices" "$UNIT_DIR"
  cp docs/deploy/piper/server.py "$HOME/tierwyn-piper/server.py"
  cp docs/deploy/systemd/tierwyn-piper.service "$UNIT_DIR/$(unit_name piper).service"
  if ! compgen -G "$voices/*.onnx" >/dev/null && ask_yn "No voices yet. Download the default voice (en_US-lessac-medium, ~60 MB)?" y; then
    # ponytail: one seed voice; the Settings → Voice downloader handles the rest of piper-voices.json.
    local base=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
    curl -fL --progress-bar "$base" -o "$voices/en_US-lessac-medium.onnx.part" \
      && curl -fsSL "$base.json" -o "$voices/en_US-lessac-medium.onnx.json" \
      && mv "$voices/en_US-lessac-medium.onnx.part" "$voices/en_US-lessac-medium.onnx" \
      && ok "voice en_US-lessac-medium" || { rm -f "$voices"/*.part; warn "voice download failed — use Settings → Voice later"; }
  fi
  hint "voice licences vary per model (some non-commercial) — check before commercial use"
  start_unit $(unit_name piper)
  wait_http http://127.0.0.1:5000/voices 30 "Piper" && hint "voices: $(curl -fsS -m3 http://127.0.0.1:5000/voices)"
}

# ── hardware detection (Kokoro profile) ───────────────────────────────────
# Layered: sysfs DRM → lspci → vendor tools. Every GPU path must also prove the
# container runtime can use it; anything unproven falls back to CPU.
# Sets: HW_CPU, HW_GPUS (lines "vendor|name"), HW_NVIDIA/HW_AMD ("ready" or a reason),
#       HW_HSA (ROCm gfx override), HW_REC (cpu|cuda|rocm), HW_WHY.
hsa_override() { # gfx_target_version int (e.g. 110003) → HSA_OVERRIDE_GFX_VERSION
  local v=$1 maj min; maj=$((v / 10000)); min=$((v / 100 % 100))
  # ponytail: community-known overrides only; anything else passes its own version — override with TIERWYN_HSA_OVERRIDE.
  case $maj.$min in 11.*) echo 11.0.0 ;; 10.3) echo 10.3.0 ;; *) echo "$maj.$min.$((v % 100))" ;; esac
}

detect_hw() {
  local arch; arch=$(uname -m)
  HW_CPU="$(lscpu 2>/dev/null | sed -n 's/^Model name: *//p' | head -1)"; HW_CPU=${HW_CPU:-unknown CPU}
  HW_CPU="$HW_CPU, $(nproc) threads, $arch"
  grep -qw avx2 /proc/cpuinfo 2>/dev/null || [[ $arch != x86_64 ]] || HW_CPU="$HW_CPU, no AVX2 (slow)"
  HW_GPUS=""; HW_NVIDIA="not detected"; HW_AMD="not detected"; HW_HSA=""
  local has_nv=0 has_amd=0 d ven name addr
  # 1. sysfs (no tools needed; works on any modern kernel with a DRM driver bound)
  for d in /sys/class/drm/card[0-9] /sys/class/drm/card[0-9][0-9]; do
    [[ -r $d/device/vendor ]] || continue
    ven=$(<"$d/device/vendor"); addr=$(basename "$(readlink -f "$d/device")")
    name=$(lspci -s "$addr" 2>/dev/null | cut -d: -f3- | sed 's/^ *//'); name=${name:-$ven:$(<"$d/device/device")}
    case $ven in 0x10de) has_nv=1; HW_GPUS+="nvidia|$name"$'\n' ;; 0x1002) has_amd=1; HW_GPUS+="amd|$name"$'\n' ;;
                 0x8086) HW_GPUS+="intel|$name"$'\n' ;; *) HW_GPUS+="other|$name"$'\n' ;; esac
  done
  # 2. lspci fallback (no DRM driver bound yet, e.g. fresh VM / missing driver)
  if [[ -z $HW_GPUS ]] && have lspci; then
    while read -r name; do
      case $name in *'[10de:'*) has_nv=1; HW_GPUS+="nvidia|$name"$'\n' ;; *'[1002:'*) has_amd=1; HW_GPUS+="amd|$name"$'\n' ;;
                    *) HW_GPUS+="other|$name"$'\n' ;; esac
    done < <(lspci -nn | grep -Ei 'vga|3d controller|display' | cut -d: -f3- | sed 's/^ *//')
  fi
  # 3. vendor tool fallback (lspci absent, e.g. minimal images)
  if (( ! has_nv )) && have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then has_nv=1; HW_GPUS+="nvidia|$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"$'\n'; fi

  # Readiness for Kokoro's PyTorch builds. CUDA build follows the driver's max CUDA version.
  HW_CUDA_IDX=""
  if (( has_nv )); then
    local cv; cv=$(nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version: *\([0-9]*\)\.\([0-9]*\).*/\1\2/p' | head -1)
    if ! nvidia-smi -L >/dev/null 2>&1; then HW_NVIDIA="driver not loaded (nvidia-smi fails)"
    elif (( ${cv:-0} >= 130 )); then HW_CUDA_IDX=cu130; HW_NVIDIA=ready
    elif (( ${cv:-0} >= 126 )); then HW_CUDA_IDX=cu126; HW_NVIDIA=ready
    else HW_NVIDIA="driver too old (CUDA ${cv:-?}; PyTorch needs 12.6+)"; fi
  fi
  if (( has_amd )); then
    local gfx; gfx=$(grep -h gfx_target_version /sys/class/kfd/kfd/topology/nodes/*/properties 2>/dev/null | awk '$2>0{print $2; exit}')
    if [[ $arch != x86_64 ]]; then HW_AMD="no $arch PyTorch ROCm build"
    elif [[ ! -e /dev/kfd ]]; then HW_AMD="/dev/kfd missing (amdgpu KFD not loaded)"
    elif [[ ! -r /dev/kfd || ! -w /dev/kfd ]] || ! compgen -G '/dev/dri/renderD*' >/dev/null; then HW_AMD="no access to /dev/kfd or /dev/dri — add $USER to render+video groups"
    elif [[ -z $gfx ]]; then HW_AMD="GPU arch unknown (no KFD topology)"
    else HW_HSA=${TIERWYN_HSA_OVERRIDE:-$(hsa_override "$gfx")}; HW_AMD="ready"
         HW_GPUS=$(sed "s/^amd|\(.*\)/amd|\1 (gfx$((gfx/10000))$(printf %x $((gfx/100%100)))$(printf %x $((gfx%100))))/" <<<"$HW_GPUS")$'\n'; fi
  fi
  if [[ $HW_NVIDIA = ready ]]; then HW_REC=cuda; HW_WHY="NVIDIA GPU ready"
  elif [[ $HW_AMD = ready ]]; then HW_REC=rocm; HW_WHY="AMD GPU ready (HSA override $HW_HSA)"
  else HW_REC=cpu
    if (( has_nv )); then HW_WHY="NVIDIA found but $HW_NVIDIA — CPU fallback"
    elif (( has_amd )); then HW_WHY="AMD found but $HW_AMD — CPU fallback"
    elif [[ -n $HW_GPUS ]]; then HW_WHY="no supported GPU (Intel/other) — CPU"
    else HW_WHY="no GPU detected — CPU"; fi
  fi
}

kokoro_env() { # profile → $CFG/kokoro.env (read by tierwyn-kokoro.service)
  local f="$CFG/kokoro.env"; mkdir -p "$(dirname "$f")"
  {
    echo "# Written by tierwyn sidecars ($1). cpu works with any PyTorch build — edit + restart to switch."
    case $1 in
      cpu) echo "KOKORO_DEVICE=cpu" ;;
      cuda) echo "KOKORO_DEVICE=cuda" ;;
      rocm) # ROCm PyTorch reports its GPU as "cuda". Values validated on gfx1103 / Radeon 780M.
        echo "KOKORO_DEVICE=cuda"
        echo "HSA_OVERRIDE_GFX_VERSION=${HW_HSA:-11.0.0}"
        echo "TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=0"
        echo "TORCH_BLAS_PREFER_HIPBLASLT=0"
        echo "PYTORCH_TUNABLEOP_HIPBLASLT_ENABLED=0"
        echo "PYTORCH_HIP_ALLOC_CONF=max_split_size_mb:64,garbage_collection_threshold:0.5"
        echo "KOKORO_GPU_MEM_FRACTION=0.15   # share of a display iGPU's VRAM; 0 = no cap" ;;
    esac
  } >"$f"
}

kokoro_venv() { # profile → ~/kokoro-venv with the matching PyTorch build + kokoro
  local venv="$HOME/kokoro-venv" idx
  case $1 in cpu) idx=cpu ;; cuda) idx=$HW_CUDA_IDX ;; rocm) idx=rocm7.1 ;; esac
  if ! have uv; then
    ask_yn "Kokoro needs uv (Python 3.12 manager, user-local in ~/.local/bin). Install it?" y || return 1
    curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh >/dev/null || { bad "uv install failed"; return 1; }
    hash -r
  fi
  # kokoro needs Python < 3.13; uv fetches a managed 3.12 when the system one is newer.
  [[ -x $venv/bin/python ]] || uv venv -q --seed --python 3.12 "$venv" || { bad "venv creation failed"; return 1; }
  if [[ $(cat "$venv/.tierwyn-torch" 2>/dev/null | head -1) != "$idx" ]]; then
    step "PyTorch ($idx) — the large download (~0.2 GB cpu, several GB for GPU builds)"
    uv pip install -q --python "$venv/bin/python" --reinstall-package torch torch \
      --index-url "https://download.pytorch.org/whl/$idx" || { bad "PyTorch install failed"; return 1; }
    echo "$idx" >"$venv/.tierwyn-torch"
  fi
  # transformers floor: without it uv can backtrack to 4.12, whose tokenizers needs a Rust build.
  uv pip install -q --python "$venv/bin/python" kokoro "misaki[zh]" "transformers>=4.45" || { bad "kokoro install failed"; return 1; }
  ok "venv $venv (torch $idx, kokoro)"
  # Japanese is best-effort: misaki[ja] needs pyopenjtalk, which has no wheel and compiles with cmake + g++.
  if uv pip install -q --python "$venv/bin/python" "misaki[ja]" unidic-lite >/dev/null 2>&1; then
    # misaki[ja] pulls `unidic`, whose ~500 MB dictionary is a separate download; without it MeCab
    # init fails. Removing it makes fugashi fall back to the bundled unidic-lite.
    uv pip uninstall -q --python "$venv/bin/python" unidic 2>/dev/null || true
    ok "Japanese voices"
  else
    warn "Japanese voices skipped — pyopenjtalk needs a compiler"
    hint "$(pkg_cmd build-essential cmake), then re-run: tierwyn sidecars"
  fi
}

kokoro_up() { # profile → 0 when /health answers
  kokoro_env "$1"
  systemctl --user daemon-reload
  systemctl --user enable $(unit_name kokoro) >/dev/null 2>&1
  systemctl --user restart $(unit_name kokoro)
  # The port only opens once the model is loaded and warmed; first start also downloads ~330 MB of weights.
  wait_http http://127.0.0.1:8880/health 300 "Kokoro ($1)"
}

sidecar_kokoro() {
  step "Kokoro TTS (127.0.0.1:8880)"
  need_user_systemd || return 0
  # Older installs ran Kokoro in Docker under the same unit name — stop it so the port frees up.
  if grep -qs 'docker' "$UNIT_DIR/$(unit_name kokoro).service"; then
    warn "replacing the Docker-based Kokoro unit with the native one"
    systemctl --user stop $(unit_name kokoro) 2>/dev/null || true
    have docker && docker rm -f kokoro >/dev/null 2>&1 || true
    hint "reclaim disk later: docker image rm ghcr.io/remsky/kokoro-fastapi-{cpu,rocm,gpu}; rm -r ~/.config/kokoro"
  fi
  if port_open 8880 && ! unit_active $(unit_name kokoro); then warn "port 8880 is taken by something else"; return 0; fi
  detect_hw
  ok "CPU: $HW_CPU"
  local g; while IFS='|' read -r _ g; do [[ -n $g ]] && ok "GPU: $g"; done <<<"$HW_GPUS"
  local profile=${TIERWYN_KOKORO_PROFILE:-}
  if [[ -z $profile ]]; then
    profile=$(menu "Run Kokoro on — recommended: $HW_REC ($HW_WHY)" "$HW_REC" \
      cpu  "CPU — always works, small install · $HW_CPU" \
      cuda "NVIDIA CUDA — $HW_NVIDIA" \
      rocm "AMD ROCm — $HW_AMD")
  fi
  case $profile in cpu|cuda|rocm) ;; *) warn "unknown profile '$profile' — using cpu"; profile=cpu ;; esac
  local state=ready; [[ $profile = cuda ]] && state=$HW_NVIDIA; [[ $profile = rocm ]] && state=$HW_AMD
  if [[ $state != ready ]] && ! ask_yn "$profile is not ready: $state.\n\nTry it anyway? (No = use CPU)" n; then profile=cpu; fi
  [[ $profile = cuda && -z ${HW_CUDA_IDX:-} ]] && HW_CUDA_IDX=cu126
  [[ $profile = rocm ]] && hint "HSA_OVERRIDE_GFX_VERSION=${HW_HSA:-11.0.0} (set TIERWYN_HSA_OVERRIDE to change)"
  have python3 || pkg_install python3
  kokoro_venv "$profile" || return 0
  mkdir -p "$HOME/tierwyn-kokoro" "$UNIT_DIR"
  cp docs/deploy/kokoro/server.py "$HOME/tierwyn-kokoro/server.py"
  cp docs/deploy/systemd/tierwyn-kokoro.service "$UNIT_DIR/$(unit_name kokoro).service"
  kokoro_up "$profile" && { kokoro_select_default; return 0; }
  # Detection can say "ready" and HIP/CUDA warm-up still fail; a GPU PyTorch build runs fine on CPU.
  if [[ $profile != cpu ]] && ask_yn "Kokoro did not come up on $profile.\n\nFall back to CPU?" y; then
    kokoro_up cpu && { kokoro_select_default; return 0; } || { bad "Kokoro failed on CPU too"; hint "journalctl --user -u $(unit_name kokoro) -n 50"; }
  else hint "journalctl --user -u $(unit_name kokoro) -f"; fi
}

kokoro_select_default() {
  hub_connect >/dev/null 2>&1 || return 0
  local cur
  cur=$(hub_api GET /settings/voice 2>/dev/null | node -e '
    const j = JSON.parse(require("fs").readFileSync(0,"utf8"));
    console.log(j?.settings?.tts?.provider ?? "");
  ' 2>/dev/null || true)
  if [[ $cur == browser || -z $cur ]]; then
    if hub_api POST /settings/voice '{"tts":{"enabled":true,"provider":"kokoro"}}' >/dev/null 2>&1; then
      ok "default TTS provider set to Kokoro"
    fi
  fi
  hub_disconnect
}

sidecar_grokbot() {
  step "Grok Bot desktop (CDP :9333)"
  need_user_systemd || return 0
  local bin="${TIERWYN_GROKBOT_BIN:-/opt/Grok Bot/grok-bot}"
  [[ -x $bin ]] || { warn "Grok Bot app not found at $bin"; hint "download the Linux .deb from https://x.ai/bot, install it, then re-run: tierwyn sidecars"; return 0; }
  ok "app: $bin"
  # Flags file survives app updates; the unit's ExecStart flag is the fallback.
  local flags="$HOME/.config/grok-bot/electron-flags.conf"
  mkdir -p "$(dirname "$flags")" "$UNIT_DIR"
  grep -qs -- '--remote-debugging-port=' "$flags" || echo '--remote-debugging-port=9333' >>"$flags"
  ok "CDP flag in $flags"
  sed "s#/opt/Grok Bot/grok-bot#$bin#" docs/deploy/systemd/tierwyn-grokbot.service >"$UNIT_DIR/$(unit_name grokbot).service"
  systemctl --user daemon-reload
  # Installed, deliberately not enabled: Tierwyn starts it on demand (Settings → Grok Bot → Auto-start).
  ok "unit installed (not enabled — Tierwyn launches it on demand)"
  hint "sign in once inside the app; it needs a graphical session"
}

whisper_installed() {
  [[ -x $HOME/.local/share/mewisper/bin/whisper-cli ]] || have whisper-cli || have whisper-cpp
}

sidecar_whisper() {
  step "Whisper STT (whisper.cpp + ffmpeg)"
  have ffmpeg || pkg_install ffmpeg

  local target_dir="$HOME/.local/share/mewisper"
  local bin_dir="$target_dir/bin"
  local models_dir="$target_dir/models"
  mkdir -p "$bin_dir" "$models_dir"

  if whisper_installed; then
    local wbin
    wbin=$(command -v whisper-cli 2>/dev/null || command -v whisper-cpp 2>/dev/null || echo "$bin_dir/whisper-cli")
    ok "whisper-cli: present ($wbin)"
  else
    step "Downloading prebuilt whisper.cpp binary..."
    local arch uname_m
    uname_m=$(uname -m)
    case $uname_m in
      x86_64) arch="x64" ;;
      aarch64|arm64) arch="arm64" ;;
      *) arch="" ;;
    esac

    local downloaded=0
    if [[ -n $arch ]] && have curl && have tar; then
      local url="https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-ubuntu-${arch}.tar.gz"
      local tmp_archive
      tmp_archive=$(mktemp)
      if curl -fsSL "$url" -o "$tmp_archive" 2>/dev/null; then
        tar -xzf "$tmp_archive" --strip-components=1 -C "$bin_dir" 2>/dev/null || true
        rm -f "$tmp_archive"
        if [[ -x "$bin_dir/whisper-cli" ]]; then
          downloaded=1
          ok "whisper-cli installed to $bin_dir"
        fi
      else
        rm -f "$tmp_archive"
      fi
    fi

    if (( ! downloaded )); then
      warn "Could not auto-download prebuilt whisper.cpp"
      hint "Install whisper-cli on \$PATH or to $bin_dir/whisper-cli"
    fi
  fi

  local base_model="$models_dir/ggml-base.bin"
  if [[ -f $base_model ]]; then
    ok "base model: ggml-base.bin present"
  elif ask_yn "Download the default Whisper base model (ggml-base.bin, ~142 MB)?" y; then
    step "Downloading GGML base model..."
    if have curl; then
      local model_url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
      local part="${base_model}.part"
      if curl -fL --progress-bar "$model_url" -o "$part"; then
        mv "$part" "$base_model"
        ok "base model downloaded to $models_dir"
      else
        rm -f "$part"
        warn "Could not download ggml-base.bin (Tierwyn can download it on demand in UI)"
      fi
    fi
  else
    hint "Skipped model download — Tierwyn can download models on demand in Settings → Voice"
  fi
}

has_gui_session() {
  [[ -n ${DISPLAY:-} || -n ${WAYLAND_DISPLAY:-} || -n ${XDG_CURRENT_DESKTOP:-} ]] && return 0
  have systemctl && systemctl is-active --quiet graphical.target 2>/dev/null && return 0
  return 1
}

do_sidecars() {
  step "Optional sidecars"
  printf '  %sSidecars provide local text-to-speech, audio dictation, and desktop bridges.%s\n' "$D" "$N"
  printf '  %sAll sidecars are optional and can be installed now or later via "tierwyn sidecars".%s\n\n' "$D" "$N"
  local s p u t; local args=()
  local sidecar_list=(
    "piper|Piper TTS — lightweight offline speech synthesis (CPU)|$(unit_name piper)"
    "kokoro|Kokoro TTS — natural neural speech synthesis (CPU or GPU)|$(unit_name kokoro)"
    "whisper|Whisper STT — local microphone dictation (whisper.cpp + ffmpeg)|whisper"
  )
  if has_gui_session || unit_active "$(unit_name grokbot)"; then
    sidecar_list+=("grokbot|Grok Bot — desktop attach to x.ai app via CDP (:9333)|$(unit_name grokbot)")
  fi
  for s in "${sidecar_list[@]}"; do
    IFS='|' read -r p u t <<<"$s"
    if [[ $p = whisper ]]; then
      whisper_installed && u="$u [ready]"
    else
      unit_active "$t" && u="$u [running]"
    fi
    args+=("$p" "$u" off)
  done
  local sel; sel=$(checklist "Install / update which sidecars? (space toggles)" "${args[@]}")
  [[ -z ${sel// } ]] && { hint "none selected — run 'tierwyn sidecars' any time"; return 0; }
  for p in $sel; do "sidecar_$p"; done
  [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) = yes ]] \
    || hint "run 'sudo loginctl enable-linger $USER' so sidecars survive logout/reboot"
  hint "pick the provider in Tierwyn: Settings → Voice"
}

# ── doctor ────────────────────────────────────────────────────────────────
do_doctor() {
  PASS=0; WARN=0; FAIL=0
  if [[ ${CMD:-} = doctor ]]; then
    local br=""
    [[ -d .git ]] && br="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)@$(git rev-parse --short=7 HEAD 2>/dev/null)"
    printf '%s┌%s  tierwyn doctor%s\n' "$C" "$N" "${br:+ · $br}"
    printf '%s│%s\n' "$D" "$N"
  fi
  step "System"
  local m; m=$(node_major)
  (( m >= MIN_NODE )) && ok "node $(node -v) ($(command -v node))" || { bad "node $MIN_NODE+ required (found: $(node -v 2>/dev/null || echo none))"; hint "tierwyn setup"; }
  have npm && ok "npm $(npm -v)" || bad "npm missing"
  have git && ok "git $(git --version | cut -d' ' -f3)" || warn "git missing (updates won't work)"
  if bwrap_ok; then ok "bwrap (namespaces OK)"
  elif have bwrap; then warn "bwrap present but user namespaces blocked — agent sandbox unavailable"
    bwrap_apparmor_blocked && hint "AppArmor userns restriction — 'tierwyn setup' offers a bwrap-only profile"
  else warn "bwrap not found — agent sandbox unavailable (optional)"; hint "$(pkg_cmd bubblewrap)"; fi
  local free; free=$(df -Pk "$ROOT" | awk 'NR==2{print int($4/1048576)}')
  (( free >= 2 )) && ok "disk: ${free} GB free" || warn "disk: only ${free} GB free on $(df -P "$ROOT" | awk 'NR==2{print $6}')"

  detect_hw; ok "CPU: $HW_CPU"
  local g v; while IFS='|' read -r v g; do [[ -n $g ]] && ok "GPU: $g"; done <<<"$HW_GPUS"
  [[ $HW_NVIDIA = ready || $HW_NVIDIA = "not detected" ]] || warn "NVIDIA: $HW_NVIDIA"
  [[ $HW_AMD = ready || $HW_AMD = "not detected" ]] || warn "AMD: $HW_AMD"
  printf '  %s· Kokoro recommendation: %s (%s)%s\n' "$D" "$HW_REC" "$HW_WHY" "$N"

  step "Checkout + build ($ROOT)"
  local head=""; [[ -d .git ]] && head=$(git rev-parse --short=8 HEAD) && ok "git $(git rev-parse --abbrev-ref HEAD) @ $head$( [[ -n $(git status --porcelain -uno) ]] && echo ' (uncommitted changes)')"
  [[ -d node_modules ]] && ok "node_modules present" || { bad "node_modules missing"; hint "npm ci"; }
  # Most common breakage after a Node upgrade: NODE_MODULE_VERSION mismatch in native addons.
  local err
  if err=$(node -e 'require("better-sqlite3"); require("argon2")' 2>&1); then ok "native modules load (better-sqlite3, argon2)"
  else bad "native modules fail to load"; hint "$(grep -m1 -E 'NODE_MODULE_VERSION|Error' <<<"$err")"; hint "npm rebuild better-sqlite3 argon2"; fi
  local d
  for d in packages/shared/dist apps/server/dist/index.js apps/web/dist/index.html; do
    [[ -e $d ]] && ok "built: $d" || { bad "not built: $d"; hint "npm run build --workspace=packages/shared && npm run build"; }
  done
  if have tierwyn; then ok "tierwyn on PATH ($(command -v tierwyn))"
  elif [[ -L $HOME/.local/bin/tierwyn ]]; then
    warn "tierwyn shim at ~/.local/bin/tierwyn (not on PATH)"
    if [[ $YES = 1 ]] || ask_yn "Add ~/.local/bin to PATH in shell profile?" y; then
      ensure_shell_path
    else
      hint "add ~/.local/bin to PATH in your shell profile"
    fi
  else
    warn "tierwyn not on PATH"
    if [[ $YES = 1 ]] || ask_yn "Install 'tierwyn' command to ~/.local/bin?" y; then
      install_shim
    else
      hint "ln -sfn $SELF $HOME/.local/bin/tierwyn"
    fi
  fi

  step "Configuration"
  local f files; files=$(env_files)
  [[ -n $files ]] || { bad "no env file (.env, ~/.config/tierwyn/prod.env, /etc/tierwyn/prod.env)"; hint "tierwyn setup"; }
  local svc_path=""
  while read -r f; do
    [[ -z $f ]] && continue
    [[ -r $f ]] || { bad "$f not readable by $USER"; hint "chown $USER '$f'; chmod 600 '$f'"; continue; }
    local perm; perm=$(stat -c %a "$f")
    [[ $perm = 600 || $perm = 400 ]] && ok "$f (mode $perm)" || { warn "$f is mode $perm (contains secrets)"; hint "chmod 600 '$f'"; }
    grep -q REPLACE_WITH "$f" && bad "$f still has REPLACE_WITH placeholders"
    local s; s=$(env_get "$f" SESSION_SECRET)
    (( ${#s} >= 32 )) || bad "SESSION_SECRET in $f is missing or < 32 chars"
    [[ $(env_get "$f" HOST) = 0.0.0.0 ]] && bad "HOST=0.0.0.0 in $f — use 127.0.0.1 + reverse proxy"
    if [[ $(env_get "$f" AUTH_DISABLED) = true ]]; then warn "AUTH_DISABLED=true in $f — localhost dev only"
    else [[ $(env_get "$f" OPERATOR_PASSWORD_HASH) == '$argon2'* ]] || bad "OPERATOR_PASSWORD_HASH in $f is not an argon2 hash"; fi
    [[ $f == *prod.env || $f == *hub.env ]] && svc_path=$(env_get "$f" PATH)
    [[ $(env_get "$f" TIERWYN_DEDICATED_HUB) = 1 ]] && ok "$f: dedicated hub (sandbox-on default, hub-tree projects refused)"

    # database
    local db; db=$(env_get "$f" TIERWYN_DB); db=${db:-./data/tierwyn.db}; [[ $db = /* ]] || db="$ROOT/${db#./}"
    if [[ -e $db ]]; then
      local v; v=$(node -e 'const D=require("better-sqlite3");const db=new D(process.argv[1],{readonly:true,fileMustExist:true});console.log(db.prepare("select max(version) v from schema_migrations").get().v)' "$db" 2>/dev/null) \
        && ok "db $db ($(du -h "$db" | cut -f1), schema v$v)" || bad "db $db exists but cannot be read"
    else warn "db $db not created yet (created on first boot)"; fi

    # live server
    local port h; port=$(env_get "$f" PORT); port=${port:-8787}
    if h=$(curl -fsS -m 3 "http://127.0.0.1:$port/health" 2>/dev/null); then
      local sha; sha=$(sed -n 's/.*"gitSha":"\([^"]*\)".*/\1/p' <<<"$h")
      ok "server up on :$port (build $sha)"
      [[ -n $head && -n $sha && $head != "$sha"* && $sha != "$head"* ]] && { warn "running build $sha ≠ checkout $head"; hint "rebuild + restart (npm run deploy:prod:full)"; }
    else warn "no server answering on :$port/health"; fi
  done <<<"$files"

  step "Services"
  services_report || true
  doctor_web_allowed_hosts

  step "Agent CLIs"
  local t bin h _i pkg n=0
  while IFS=$'\t' read -r t bin h _i pkg; do
    if have "$bin" || [[ $bin == /* && -e $bin ]]; then
      n=$((n+1))
      # The prod unit only sees the env file's PATH — the classic `spawn <agent> ENOENT`.
      if [[ -n $svc_path && $bin != /* ]] && ! PATH="$svc_path" command -v "$bin" >/dev/null; then
        warn "$t: on your shell PATH but not on the service PATH"; hint "add $(dirname "$(command -v "$bin")") to PATH= in the prod env file"
      else ok "$t ($bin)"; fi
      # WP-2.3: installed vs npm latest — best-effort, offline hosts just skip.
      if [[ -n ${pkg:-} ]]; then
        local iv lv cmp
        iv=$(timeout 10 "$bin" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z][0-9A-Za-z.-]*)?' | head -1)
        lv=$(timeout 20 npm view "$pkg" version 2>/dev/null | tail -n1)
        if [[ -n $iv && -n $lv && $iv != "$lv" ]]; then
          cmp=$(node -e 'const p=s=>s.split("+")[0];const c=(a,b)=>{const A=a.split("-"),B=b.split("-");const n=x=>x.split(".").map(Number);for(let i=0;i<3;i++){if(n(A[0])[i]!==n(B[0])[i])return n(A[0])[i]<n(B[0])[i]?-1:1}if(!A[1])return B[1]?1:0;if(!B[1])return -1;return 0};console.log(c(p(process.argv[1]),p(process.argv[2]))<0?"behind":"ok")' "$iv" "$lv" 2>/dev/null)
          [[ $cmp == behind ]] && warn "$t: $iv installed · $lv available"
        fi
      fi
    else printf '  %s· %s not installed%s\n' "$D" "$t" "$N"; fi
  done < <(agents_tsv)
  (( n > 0 )) || { bad "no agent CLI installed"; hint "tierwyn agents"; }

  step "Optional sidecars"
  local p
  for p in "5000 Piper TTS" "8880 Kokoro TTS" "9333 Grok Bot CDP"; do
    (exec 3<>"/dev/tcp/127.0.0.1/${p%% *}") 2>/dev/null && ok "${p#* } (:${p%% *})" || printf '  %s· %s not listening (:%s)%s\n' "$D" "${p#* }" "${p%% *}" "$N"
  done
  if whisper_installed; then
    local wbin
    wbin=$(command -v whisper-cli 2>/dev/null || command -v whisper-cpp 2>/dev/null || echo "$HOME/.local/share/mewisper/bin/whisper-cli")
    ok "Whisper STT ($wbin)"
    if have ffmpeg; then
      ok "ffmpeg ($(command -v ffmpeg))"
    else
      warn "ffmpeg missing — required for Whisper STT audio preprocessing"
    fi
  else
    printf '  %s· Whisper STT not installed%s\n' "$D" "$N"
  fi

  printf '\n%s└%s  %s%d ok · %d warnings · %d failures%s\n' "$D" "$N" "$B" "$PASS" "$WARN" "$FAIL" "$N"
  (( FAIL == 0 ))
}

services_report() {
  if have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    local u found=0
    for u in $(unit_name prod) $(unit_name prod-web) $(unit_name hub) $(unit_name hub-web) $(unit_name piper) $(unit_name kokoro) $(unit_name grokbot); do
      systemctl --user cat "$u.service" >/dev/null 2>&1 || continue; found=1
      local st; st=$(systemctl --user is-active "$u" 2>/dev/null || true)
      case $st in active) ok "$u: active";; failed) bad "$u: failed"; hint "journalctl --user -u $u -n 50";; *) warn "$u: $st";; esac
    done
    (( found )) || warn "no tierwyn systemd user units installed (fine for dev)"
    (( found )) && [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) != yes ]] && warn "linger off — services stop at logout" && hint "sudo loginctl enable-linger $USER"
    (( found ))
  else
    warn "systemd user session unavailable"
    return 1
  fi
}

# ── next step: one cheap probe of on-disk state → home default, setup ending, every command's exit ──
next_step() { # → NEXT (tierwyn subcommand, "" when the advice is plain text) + WHY
  NEXT="" WHY=""
  local prod; prod=$(pair_env); local port
  [[ -r $prod ]] || prod=/etc/tierwyn/prod.env
  have tierwyn || [[ -L $HOME/.local/bin/tierwyn ]] || { NEXT=shim WHY="'tierwyn' command not installed on PATH"; return 0; }
  [[ -f apps/server/dist/index.js ]] || { NEXT=setup WHY="Tierwyn isn't built yet"; return 0; }
  [[ -r $prod || -r $ROOT/.env ]] || { NEXT=config WHY="no configuration yet — choose dev or prod"; return 0; }
  if [[ -r $prod ]] && have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    port=$(env_get "$prod" PORT); port=${port:-8788}
    unit_installed "$(api_unit)" || { NEXT=services WHY="systemd services not installed"; return 0; }
    unit_active "$(api_unit)" && unit_active "$(web_unit)" || { NEXT=start WHY="Tierwyn is stopped"; return 0; }
    curl -fsS -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1 || { NEXT=logs WHY="Tierwyn is running but not answering on :$port"; return 0; }
  fi
  any_agent_installed || { NEXT=agents WHY="no agent CLI installed yet"; return 0; }
  if [[ -r $prod ]]; then
    [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) = yes ]] \
      || { NEXT=linger WHY="services stop at logout/reboot until linger is on (runs sudo loginctl enable-linger)"; return 0; }
  fi
  WHY="all set — $(open_hint)"
}

any_agent_installed() {
  local t bin _h _i
  while IFS=$'\t' read -r t bin _h _i; do
    have "$bin" || [[ $bin == /* && -e $bin ]] && return 0
  done < <(agents_tsv)
  return 1
}

open_hint() { # how to reach the UI from here
  local prod; prod=$(pair_env); [[ -r $prod ]] || prod=/etc/tierwyn/prod.env
  [[ -r $prod ]] || { echo "run 'npm run dev', then open http://localhost:5173"; return; }
  local ip; ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [[ $(env_get "$prod" COOKIE_SECURE) = false ]]; then
    echo "open http://${ip:-<this-host>}:4173 and sign in (install and enable agents in ⚙ Settings → Agents)"
  else
    echo "open Tierwyn via your HTTPS reverse proxy (→ ${ip:-<this-host>}:4173) and sign in; COOKIE_SECURE=true, so plain http:// login will bounce (set COOKIE_SECURE=false in $prod for direct HTTP)"
  fi
}

show_next() {
  next_step
  if [[ -n $NEXT ]]; then printf '\n%s→%s next: %stierwyn %s%s  %s%s%s\n' "$C" "$N" "$B" "$NEXT" "$N" "$D" "$WHY" "$N"
  else printf '\n%s→%s %s\n' "$C" "$N" "$WHY"; fi
}

TO_MENU=0
phase() { # phase n title what [continue|skip] → 0 run it, 1 skip (or back to menu: TO_MENU=1)
  (( TO_MENU )) && return 1
  echo
  local r
  r=$(menu "Step $1/6 · $2" "${4:-continue}" \
    continue "Continue — $3" \
    skip     "Skip this step" \
    menu     "Exit to menu") || r=menu
  case $r in continue) return 0 ;; menu) TO_MENU=1 ;; esac
  return 1
}

next_prompt() { # after a command → sets CMD to run next, "" for the home menu; exits on skip
  local rc=${1:-0} r def=continue
  next_step
  if [[ -z $NEXT || $YES = 1 ]]; then show_next; exit "$rc"; fi
  [[ $NEXT = "$CMD" ]] && def=skip   # same step again (e.g. nothing picked) — don't nag
  printf '\n%s→%s next: %stierwyn %s%s  %s%s%s\n' "$C" "$N" "$B" "$NEXT" "$N" "$D" "$WHY" "$N"
  r=$(menu "Next: tierwyn $NEXT" "$def" \
    continue "Continue — run tierwyn $NEXT now" \
    skip     "Skip — exit" \
    menu     "Exit to menu") || r=skip
  case $r in continue) CMD=$NEXT ;; menu) CMD="" ;; *)
    # agents/linger come after the health check, so the UI is up — say where it is.
    [[ $NEXT = agents || $NEXT = linger ]] && printf '\n%s→%s Tierwyn is running — %s\n' "$C" "$N" "$(open_hint)"
    printf '  %sRun %stierwyn %s%s%s any time to pick this up.%s\n' "$D" "$B" "$NEXT" "$N" "$D" "$N"
    exit "$rc" ;; esac
}

cmd_header() {
  local sub=$1 br=""
  [[ -d .git ]] && br="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)@$(git rev-parse --short=7 HEAD 2>/dev/null)"
  printf '%s┌%s  tierwyn %s%s\n' "$C" "$N" "$sub" "${br:+ · $br}"
}

pretty_root() {
  local p=$ROOT
  [[ $p == "$HOME"* ]] && p="~${p#"$HOME"}"
  printf '%s' "$p"
}

home_status() {
  local br="" port=8788 prod web build="" p; p=$(pair); local envf; envf=$(pair_env "$p")
  local au; au=$(api_unit "$p"); local wu; wu=$(web_unit "$p")
  [[ -d .git ]] && br="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)@$(git rev-parse --short=7 HEAD 2>/dev/null)"
  printf '%s┌%s  tierwyn · %s%s\n' "$C" "$N" "$(pretty_root)" "${br:+ · $br}"
  if have systemctl && systemctl --user show-environment >/dev/null 2>&1 && unit_installed "$au"; then
    [[ -r $envf ]] && port=$(env_get "$envf" PORT)
    port=${port:-8788}
    if unit_active "$au"; then prod="$p ● active :$port"
    else prod="$p ○ $(systemctl --user is-active "$au" 2>/dev/null || echo inactive) :$port"; fi
    if unit_active "$wu"; then web="web ● active :4173"
    else web="web ○ $(systemctl --user is-active "$wu" 2>/dev/null || echo inactive) :4173"; fi
    local h; h=$(curl -fsS -m 2 "http://127.0.0.1:$port/health" 2>/dev/null || true)
    build=$(sed -n 's/.*"gitSha":"\([^"]*\)".*/\1/p' <<<"$h")
    printf '%s│%s  %s · %s%s\n' "$D" "$N" "$prod" "$web" "${build:+ · build $build}"
  else
    printf '%s│%s  dev · no systemd units · npm run dev\n' "$D" "$N"
  fi
  printf '%s│%s\n' "$D" "$N"
}

units_for() { # target → sets want=()  (pair = whichever API + web pair is installed)
  case $1 in
    pair|"") want=($(api_unit) $(web_unit)) ;;
    prod|hub) want=($(api_unit "$1") $(web_unit "$1")) ;;
    all) want=($(api_unit) $(web_unit) $(unit_name piper) $(unit_name kokoro) $(unit_name grokbot)) ;;
    piper) want=($(unit_name piper)) ;;
    kokoro) want=($(unit_name kokoro)) ;;
    grokbot) want=($(unit_name grokbot)) ;;
    *) echo "unknown target: $1" >&2; exit 2 ;;
  esac
}

do_lifecycle() { # verb target
  local verb=$1 target=${2:-pair}
  have systemctl && systemctl --user show-environment >/dev/null 2>&1 || { warn "systemd user session unavailable"; exit 1; }
  local -a want=() run=() skip=() u
  units_for "$target"
  for u in "${want[@]}"; do
    if systemctl --user cat "$u.service" >/dev/null 2>&1; then run+=("$u")
    else skip+=("$u"); fi
  done
  (( ${#run[@]} )) || { warn "no matching units installed"; services_report || true; exit 1; }
  local extra=""
  (( ${#skip[@]} )) && extra=" (${skip[*]// /, }: not installed)"
  _collapse "$verb" "${run[*]}$extra"
  # restart/start without re-render — backfill TIERWYN_ALLOWED_HOSTS if the live unit predates it.
  if [[ $verb != stop ]]; then
    for u in "${run[@]}"; do
      [[ $u = $(unit_name prod-web) || $u = $(unit_name hub-web) ]] && ensure_prod_web_allowed_hosts "$UNIT_HOME/$u.service"
    done
  fi
  systemctl --user "$verb" "${run[@]}"
  # Wait for boot so the next-step check doesn't misread a starting server as broken.
  local b port
  [[ $verb = stop ]] || for b in prod hub; do
    [[ " ${run[*]} " == *" $(api_unit "$b") "* ]] || continue
    port=$(env_get "$(pair_env "$b")" PORT)
    wait_http "http://127.0.0.1:${port:-8788}/health" 60 "Tierwyn ($b)" || true
  done
  services_report || true
}

do_logs() { # target
  have journalctl || die "journalctl not available"
  local -a want=() args=() u
  units_for "${1:-pair}"
  for u in "${want[@]}"; do args+=(-u "$u"); done
  exec journalctl --user "${args[@]}" -n 100 -f
}

do_node_setup() {
  step "Node host setup (remote daemon — not the hub)"
  # The node is a systemd *user* unit. Root (or sudo -iu / su) usually has no user
  # bus, and the later `systemctl --user daemon-reload` would die under set -e with
  # a bare "Failed to connect to bus". Fail up front with the actual fix.
  if have systemctl && ! systemctl --user show-environment >/dev/null 2>&1; then
    bad "systemd user session unavailable for $(id -un)"
    (( EUID == 0 )) && hint "don't run the node as root: agents it spawns would have root on this machine"
    hint "use a dedicated unprivileged user with linger:"
    hint "  useradd -m -s /bin/bash tierwyn && loginctl enable-linger tierwyn"
    hint "  machinectl shell tierwyn@   (not sudo -iu / su — they don't start a user bus; apt install systemd-container)"
    hint "then re-run the node one-liner as that user"
    die "node setup needs a systemd user session"
  fi
  local missing=() t
  for t in git curl tar xz unzip; do have "$t" && ok "$t" || missing+=("$t"); done
  [[ ${#missing[@]} = 0 ]] || pkg_install "${missing[@]}"
  ensure_bwrap
  local m; m=$(node_major)
  if (( m >= MIN_NODE )) && node_version_ok "$MIN_NODE"; then ok "Node $(node -v)"
  else
    [[ $m = 0 ]] && warn "Node.js not found" || warn "Node $(node -v) is older than floor 22.13 (or <24.22.1)"
    ask_yn "Install Node $NODE_MAJOR into ~/.local (official tarball, checksum-verified)?" y && install_node
    node_version_ok "$MIN_NODE" || die "Node 22.13+ is required"
  fi
  export_agent_path
  sync_node_path
  if (( PACKAGED )); then
    install_shim
  else
    [[ -L node_modules ]] && die "node_modules is a symlink — refusing npm ci (it would wipe $(readlink -f node_modules))"
    npm ci --no-audit --no-fund || {
      bad "npm ci failed"
      have g++ || hint "no C++ toolchain to compile native modules — $(pkg_cmd build-essential python3), then re-run"
      die "npm ci failed"
    }
    npm run build --workspace=packages/shared
    npm run build --workspace=apps/server
    ok "built packages/shared + apps/server"
  fi
  local udir="$HOME/.config/systemd/user" node_bin
  node_bin=$(command -v node) || true
  [[ -n $node_bin ]] || die "node not found on PATH — Node $MIN_NODE+ is required (setup already ran install_node if you accepted it)"
  mkdir -p "$udir"
  local NODE_TPL=tierwyn-node.service
  # ponytail: same sed as render_prod_units — clone path is not always %h/Tierwyn;
  # pin ExecStart to the node we just verified so a lingered user unit is not
  # stuck with systemd's default PATH (/usr/bin) missing ~/.local/bin.
  sed -e "s#%h/tierwyn-node#$ROOT#g" \
      -e "s#/usr/bin/env node#$node_bin#g" \
    "$ROOT/docs/deploy/systemd/$NODE_TPL" >"$udir/$(unit_name node).service"
  have systemctl && systemctl --user daemon-reload
  ok "installed $(unit_name node).service (not enabled, not started)"
  # Without linger the user manager (and so the node unit) only starts when this
  # user logs in — after a reboot the host stays "disconnected" on the hub.
  local me=${USER:-$(id -un)} # USER is unset under some sudo/systemd contexts (set -u)
  if have loginctl && [[ $(loginctl show-user "$me" -p Linger --value 2>/dev/null) != yes ]]; then
    local sudo_cmd=(sudo); [[ $YES = 1 ]] && sudo_cmd=(sudo -n) # no tty → don't hang on a password prompt
    if ask_yn "Linger is off: the node daemon will not start after a reboot until $me logs in.\n\nEnable linger now (sudo loginctl enable-linger $me)?" y \
       && "${sudo_cmd[@]}" loginctl enable-linger "$me"; then
      ok "linger on — the node daemon starts at boot"
    else
      warn "linger off — after a reboot this node stays disconnected until $me logs in"
      hint "run: sudo loginctl enable-linger $me"
    fi
  fi
  hint "run: tierwyn node allow <agent>… (or re-enroll with --all-agents) before tierwyn node start"
}

do_node() {
  local sub=${1:-}
  if (($#)); then shift; fi
  case $sub in
    setup) do_node_setup ;;
    enroll)
      [[ -f apps/server/dist/node/main.js ]] || do_node_setup
      node apps/server/dist/node/main.js enroll "$@"
      ;;
    run)
      exec node apps/server/dist/node/main.js run
      ;;
    start|stop|restart)
      have systemctl && systemctl --user show-environment >/dev/null 2>&1 || die "systemd user session unavailable"
      step "${sub^}ing $(unit_name node).service"
      # start/restart also enable, so the daemon comes back after a reboot.
      if [[ $sub = stop ]]; then systemctl --user stop $(unit_name node).service
      else systemctl --user enable $(unit_name node).service >/dev/null 2>&1 || true; systemctl --user "$sub" $(unit_name node).service; fi
      if [[ $sub != stop ]]; then
        sleep 1
        if systemctl --user is-active $(unit_name node).service >/dev/null 2>&1; then
          ok "$(unit_name node).service is active (running)"
        else
          bad "$(unit_name node).service failed to start — run: tierwyn node logs"
        fi
      else
        ok "$(unit_name node).service stopped"
      fi
      ;;
    logs)
      have journalctl || die "journalctl not available"
      exec journalctl --user -u $(unit_name node).service -n 100 -f
      ;;
    update) do_node_update "$@" ;;
    allow|disallow|status)
      [[ -f apps/server/dist/node/main.js ]] || die "node not built — run: tierwyn node setup"
      exec node apps/server/dist/node/main.js "$sub" "$@"
      ;;
    *)
      echo "usage: tierwyn node setup|enroll|run|start|stop|restart|logs|update|allow|disallow|status" >&2
      echo "  remote-host daemon — not the hub (tierwyn setup / tierwyn start prod)" >&2
      exit 2
      ;;
  esac
}

do_node_update() {
  local from_hub=0 allow_http=0
  while (($#)); do
    case $1 in
      --from-hub) from_hub=1 ;;
      --allow-http) allow_http=1 ;;
      *) die "unknown flag: $1" ;;
    esac
    shift
  done

  local dir="${TIERWYN_NODE_DIR:-$CFG/node}" udir="$HOME/.config/systemd/user"
  local settle=${TIERWYN_UPDATE_SETTLE_S:-8}
  mkdir -p "$dir"

  local rc=0
  if (( ! PACKAGED )) && (( ! from_hub )); then
    step "Updating tierwyn node from git ($ROOT, $(channel_get))"
    set +e
    (
      set -e
      git_sync "$ROOT"
      node_version_ok "$MIN_NODE" || install_node
      sync_node_path
      if [[ -f $udir/$(unit_name node).service ]] && have node; then
        sed -i "s#^ExecStart=.* main\\.js run#ExecStart=$(command -v node) $ROOT/apps/server/dist/node/main.js run#" "$udir/$(unit_name node).service"
        have systemctl && systemctl --user daemon-reload
      fi
      (cd "$ROOT" && npm ci --no-audit --no-fund && npm run build --workspace=packages/shared && npm run build --workspace=apps/server)
      systemctl --user restart $(unit_name node).service
    ) >>"$dir/update.log" 2>&1
    rc=$?
    set -e
    if (( rc )); then
      printf 'update failed — see %s\n' "$dir/update.log" >&2
      return "$rc"
    fi
    sleep 1
    if systemctl --user is-active $(unit_name node).service >/dev/null 2>&1; then
      local sha; sha=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)
      ok "Node updated and running (${sha:-active})"
    else
      bad "Node update applied but $(unit_name node).service failed to restart — check $dir/update.log"
    fi
    return 0
  fi

  local target converting=0
  if (( PACKAGED )); then
    target=$ROOT
  else
    converting=1
    target="${TIERWYN_DIR:-$(home_dir -node)}"
    [[ -d $target/.git ]] && die "target $target is a git checkout"
    if [[ -e $target ]] && [[ -n $(ls -A "$target" 2>/dev/null) ]] && [[ ! -f $target/BUILD_ID ]]; then
      die "target $target is not empty and is not a package install (no BUILD_ID)"
    fi
  fi

  grep -q package-fetch "$ROOT/apps/server/dist/node/main.js" 2>/dev/null \
    || die "current node binary lacks package-fetch — run tierwyn node update first"

  step "Updating tierwyn node from hub package"
  rm -f "$dir/update.outcome"
  set +e
  (
    set -e
    node_version_ok "$MIN_NODE" || install_node
    sync_node_path
    tmp=$(mktemp)
    fetch_args=(package-fetch --out "$tmp")
    if (( allow_http )); then fetch_args+=(--allow-http); fi
    if ! id=$(node "$ROOT/apps/server/dist/node/main.js" "${fetch_args[@]}"); then
      rm -f "$tmp"
      exit 1
    fi
    current=$(tr -d '[:space:]' < "$target/BUILD_ID" 2>/dev/null || true)
    id=$(tr -d '[:space:]' <<<"$id")
    if (( ! converting )) && [[ -n $id && $id = "$current" ]]; then
      rm -f "$tmp"
      printf 'uptodate\n' >"$dir/update.outcome"
      exit 0
    fi
    printf 'updated\n' >"$dir/update.outcome"
    unit_bak=""
    if (( converting )) && [[ -f $udir/$(unit_name node).service ]]; then
      unit_bak="$udir/$(unit_name node).service.bak"
      cp "$udir/$(unit_name node).service" "$unit_bak"
    fi
    if ! pkg_swap "$tmp" "$target" --smoke; then
      rm -f "$tmp"
      exit 1
    fi
    rm -f "$tmp"
    if (( converting )); then
      bash "$target/scripts/install.sh" --yes node setup
    fi
    # restart can return non-zero (no user bus, start-limit, masked unit)
    # while set -e would skip the is-active rollback. is-active decides.
    systemctl --user restart $(unit_name node).service || true
    sleep "$settle"
    if ! systemctl --user is-active $(unit_name node).service >/dev/null; then
      if [[ -d $target.prev ]]; then
        rm -rf "$target.failed"
        mv "$target" "$target.failed"
        mv "$target.prev" "$target"
      fi
      if [[ -n $unit_bak && -f $unit_bak ]]; then
        mv "$unit_bak" "$udir/$(unit_name node).service"
        have systemctl && systemctl --user daemon-reload
      fi
      if (( converting )); then
        mkdir -p "$HOME/.local/bin"
        ln -sfn "$ROOT/scripts/install.sh" "$HOME/.local/bin/tierwyn"
              fi
      systemctl --user restart $(unit_name node).service
      exit 1
    fi
    rm -f "$unit_bak"
  ) >>"$dir/update.log" 2>&1
  rc=$?
  set -e
  local bid outcome
  bid=$(tr -d '[:space:]' < "$target/BUILD_ID" 2>/dev/null || echo unknown)
  outcome=$(tr -d '[:space:]' < "$dir/update.outcome" 2>/dev/null || true)
  rm -f "$dir/update.outcome"
  if (( rc )); then
    printf 'update failed — see %s\n' "$dir/update.log" >&2
    if [[ -f $dir/update.log ]]; then
      printf 'last lines:\n' >&2
      tail -n 20 "$dir/update.log" >&2 || true
    fi
    return "$rc"
  fi
  if [[ $outcome = uptodate ]]; then
    ok "Already up to date ($bid)"
  else
    ok "Node updated to $bid"
    if (( converting )); then hint "checkout left at $ROOT — safe to delete"; fi
  fi
  if have systemctl && systemctl --user is-active $(unit_name node).service >/dev/null 2>&1; then
    ok "$(unit_name node).service is running"
  else
    warn "$(unit_name node).service is not running"
    hint "start it: tierwyn node start"
  fi
}

pkg_version() {
  node -e 'try { console.log(JSON.parse(require("fs").readFileSync("package.json","utf8")).version || "unknown"); } catch { console.log("unknown"); }' 2>/dev/null || echo "unknown"
}

do_update() {
  [[ -d .git ]] || die "not a git checkout — re-run the curl installer instead"
  local force=0
  [[ ${TARGET:-} = --force || ${TARGET:-} = force || ${1:-} = --force ]] && force=1
  local old_ver old_sha new_ver new_sha
  old_ver=$(pkg_version)
  old_sha=$(git rev-parse --short=8 HEAD 2>/dev/null || echo "unknown")

  step "Checking for updates (current: v${old_ver} · ${old_sha} · $(channel_get) channel)"
  if ! git_sync "$ROOT"; then
    if (( force )); then
      warn "pull failed (no access, or local changes?) — continuing rebuild (--force)"
    else
      warn "pull failed (no access, or local changes?) — pass 'tierwyn update --force' to rebuild anyway"
      return 1
    fi
  fi

  new_ver=$(pkg_version)
  new_sha=$(git rev-parse --short=8 HEAD 2>/dev/null || echo "unknown")
  if (( ! force )) && [[ $old_sha = "$new_sha" ]] && [[ -f apps/server/dist/index.js && -f apps/web/dist/index.html ]]; then
    ok "Already up to date (v${new_ver} · ${new_sha})"
    return 0
  fi

  do_build --no-pull
  # update never re-renders units; backfill TIERWYN_ALLOWED_HOSTS so a reverse-proxied
  # domain does not get Vite 403 after the allowedHosts gating change.
  ensure_prod_web_allowed_hosts
  local -a live=() u
  for u in $(api_unit) $(web_unit) $(unit_name grokbot); do unit_active "$u" && live+=("$u"); done
  if (( ${#live[@]} )); then
    step "Restarting ${live[*]}"
    systemctl --user restart "${live[@]}"
    local port; port=$(env_get "$(pair_env)" PORT)
    wait_http "http://127.0.0.1:${port:-8788}/health" 60 "Tierwyn" || true
  else
    hint "no running services — dev: npm run dev"
  fi
  if [[ $old_ver != "$new_ver" ]]; then
    ok "Updated v${old_ver} → v${new_ver} (${old_sha} → ${new_sha})"
  else
    ok "Updated v${new_ver} (${old_sha} → ${new_sha})"
  fi
}

# ── main ──────────────────────────────────────────────────────────────────
rec() { [[ $1 = "$NEXT" ]] && echo "  ← next" || true; }
home() { # home menu → CMD
  banner
  home_status
  next_step
  if [[ -n $NEXT ]]; then printf '%s│%s  %snext:%s tierwyn %s %s— %s%s\n%s│%s\n' "$D" "$N" "$Y" "$N" "$NEXT" "$D" "$WHY" "$N" "$D" "$N"
  else printf '%s│%s  %s%s%s\n%s│%s\n' "$D" "$N" "$G" "$WHY" "$N" "$D" "$N"; fi
  CMD=$(menu "What would you like to do?" "${NEXT:-doctor}" \
    setup    "Full setup — prereqs, build, config, services, agents, sidecars$(rec setup)" \
    update   "Pull latest, rebuild, restart running services" \
    doctor   "Run diagnostics" \
    status   "Show service status" \
    start    "Start Tierwyn (API + web)$(rec start)" \
    stop     "Stop Tierwyn (API + web)" \
    restart  "Restart Tierwyn (API + web)" \
    logs     "Follow Tierwyn logs$(rec logs)" \
    config   "Change run mode, port, password$(rec config)" \
    agents   "Install / enable agent CLIs$(rec agents)" \
    services "Install / restart systemd user services$(rec services)" \
    sidecars "Optional sidecars (Piper, Kokoro, Whisper, Grok Bot)" \
    shim     "Install / verify 'tierwyn' command in ~/.local/bin and PATH$(rec shim)" \
    linger   "Keep services running after logout (sudo)$(rec linger)" \
    help     "Show help guide explaining commands and sidecars" \
    quit     "Quit") || exit 0
}

# Sourced by tests: helpers only, no dispatch.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

# Loop: every command ends by offering the next step — continue runs it, menu goes home, skip exits.
FROM_HOME=0; [[ -z $CMD ]] && FROM_HOME=1
while :; do
  [[ -z $CMD ]] && home
  [[ $CMD = setup || $CMD = install ]] && { (( FROM_HOME )) || banner; }
  [[ $CMD =~ ^(setup|install|start|stop|restart|doctor|logs|quit|help|node|hub)$ ]] || cmd_header "$CMD"
  rc=0
  case $CMD in
    install|setup) do_install; (( TO_MENU )) && { CMD=""; continue; } ;;
    config) do_config ;;
    doctor) do_doctor || rc=1 ;;
    status) services_report || true ;;  # lists prod + hub + sidecar units
    start|stop|restart) do_lifecycle "$CMD" "${TARGET:-pair}" ;;
    logs) do_logs "${TARGET:-pair}" ;;
    hub) echo "usage: tierwyn hub start|stop|restart|logs|status" >&2; exit 2 ;;
    update) do_update ;;
    channel) do_channel; exit 0 ;;
    agents) do_agents ;;
    services) do_services ;;
    sidecars) do_sidecars ;;
    shim) install_shim ;;
    linger) sudo loginctl enable-linger "$USER" && ok "linger on — services survive logout/reboot" || bad "enable-linger failed" ;;
    node) do_node "${NODE_ARGS[@]}"; exit 0 ;;
    help) print_help ;;
    quit) exit 0 ;;
  esac
  TARGET=""
  # stop is deliberate — suggesting "start" right after it would be noise.
  [[ $CMD = stop ]] && exit 0
  next_prompt "$rc"
done
