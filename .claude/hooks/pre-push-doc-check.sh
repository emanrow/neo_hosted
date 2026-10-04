#!/bin/bash
# Block git push when new source files were added without any doc tree updates.
# Diffs the current branch against main; only ADDED files count (conservative).
BASE=main
git rev-parse --verify -q origin/main >/dev/null 2>&1 && BASE=origin/main
NEW_SRC=$(git diff --name-only --diff-filter=A "$BASE"...HEAD 2>/dev/null \
  | grep -E '^(web/(server|lib/.*|public/.*)\.js|[a-z-]+\.js)$' | grep -vE '\.test\.js$' || true)

if [ -z "$NEW_SRC" ]; then
  exit 0
fi

DOC_CHANGES=$(git diff --name-only "$BASE"...HEAD 2>/dev/null \
  | grep -E '(^docs/|CLAUDE\.md|^HOSTED\.md|^AGENTS\.md)' || true)

if [ -z "$DOC_CHANGES" ]; then
  echo "BLOCKED: You added new source files but did not update the doc tree." >&2
  echo "" >&2
  echo "New source files:" >&2
  echo "$NEW_SRC" | sed 's/^/  /' >&2
  echo "" >&2
  echo "Per the documentation policy in CLAUDE.md, new modules must be" >&2
  echo "documented in the doc tree (docs/*.md, web/CLAUDE.md) and linked from CLAUDE.md." >&2
  echo "Update the docs, then push again." >&2
  exit 2
fi

exit 0
