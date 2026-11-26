#!/bin/sh
# Report every plugin the launcher declined to mount, from the newest boot only.
#
# Four failures read differently and mean the same thing -- the plugin is not
# running: a bundle the loader skipped, a profile row cordis disabled, a package
# whose own import threw, and an entry that loaded but whose apply() failed. None
# leaves anything on disk, so a build that inspects only files reports success
# over a workspace that is missing the capability. The composition is the
# reviewed list of what this deployment runs, so every member is expected to
# mount; this prints "clean" when they all do.
#
# The newest boot is the one that matters: earlier boots' failures are already
# reported, and web.log accumulates across restarts.
#
# Usage: plugins-not-mounted.sh [log]
LOG=${1:-/workspace/.dataops/dsh/logs/web.log}
if [ ! -f "$LOG" ]; then
  echo "no-log"
  exit 0
fi
SEG=$(awk '/dataops-dsh-service\] starting/{n=NR} END{print n}' "$LOG")
[ -n "$SEG" ] || SEG=1
OUT=$(tail -n +"$SEG" "$LOG" | awk '
  # A count line introduces the entries that follow it, each named at the start
  # of its own line before the parenthesised module URL.
  /entr(y|ies) did not activate/ {
    pending = $0
    sub(/^.*: /, "", pending)
    sub(/ .*$/, "", pending)
    n = pending + 0
    next
  }
  n > 0 && /^[^ ]+ \(/ {
    line = $0
    sub(/ \(.*$/, "", line)
    if (line != "") print "inactive " line
    n--
    next
  }
  match($0, /skipping profile bundle "[^"]+"/) {
    v = substr($0, RSTART + 25, RLENGTH - 26); print "skip " v; next
  }
  match($0, /disabling profile plugin row "[^"]+"/) {
    v = substr($0, RSTART + 30, RLENGTH - 31); print "disable " v; next
  }
  match($0, /: failed to import$/) {
    if (match($0, /\([^)]+\)/)) {
      v = substr($0, RSTART + 1, RLENGTH - 2); print "import " v; next
    }
  }
' | sort -u)
if [ -z "$OUT" ]; then
  echo clean
else
  printf '%s\n' "$OUT"
fi
