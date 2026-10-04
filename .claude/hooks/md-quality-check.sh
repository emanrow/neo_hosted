#!/bin/bash
# PostToolUse (Write/Edit) quality gate for markdown: size cap, breadcrumb, stale-status words.
# Upstream NEO's own docs keep upstream's shape, so they are exempt from the breadcrumb.
FILE="$TOOL_INPUT_file_path"
case "$FILE" in *.md) ;; *) exit 0 ;; esac
LINES=$(wc -l < "$FILE" 2>/dev/null || echo 0)
BASENAME=$(basename "$FILE")
HAS_BREADCRUMB=$(head -3 "$FILE" 2>/dev/null | grep -c 'CLAUDE.md' || true)
STALE_WORDS=$(head -80 "$FILE" 2>/dev/null | grep -oE 'Proposed|Partially implemented|TBD|WIP' | sort -u | paste -sd, -)
UPSTREAM=0
case "$BASENAME" in CLAUDE.md|README.md|AGENTS.md|CONTRIBUTING.md|TRANSLATING.md|TUTORIAL.md) UPSTREAM=1 ;; esac
case "$FILE" in */pocket/*|*/licenses/*|*/scripts/*|*/node_modules/*) UPSTREAM=1 ;; esac
WARNINGS=''
if [ "$LINES" -gt 300 ]; then
  WARNINGS="WARNING: $BASENAME is $LINES lines (cap is ~300). Split this file into smaller docs and link from the parent."
fi
if [ "$UPSTREAM" -eq 0 ] && [ "$HAS_BREADCRUMB" -eq 0 ]; then
  WARNINGS="$WARNINGS WARNING: $BASENAME is missing a breadcrumb backlink in its first 3 lines. Add: > [CLAUDE.md](../CLAUDE.md) > Page Name"
fi
if [ "$UPSTREAM" -eq 0 ] && [ -n "$STALE_WORDS" ]; then
  WARNINGS="$WARNINGS WARNING: $BASENAME contains stale-status words ($STALE_WORDS) in its first 80 lines. Verify each still applies."
fi
if [ -n "$WARNINGS" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$WARNINGS"
fi
exit 0
