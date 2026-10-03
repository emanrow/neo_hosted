#!/bin/bash
# Block git push when the branch adds something that must not be public:
# secrets and tokens, email addresses, home-directory paths, references to
# the owner's other repositories (everything under emanrow/ except this one),
# or time-zone and location details. Scans added lines in the diff against
# main and every commit message on the branch. A net, not a substitute for
# reading your own diff; see docs/public-repo.md.
BASE=main
git rev-parse --verify -q origin/main >/dev/null 2>&1 && BASE=origin/main

ADDED=$(git diff "$BASE"...HEAD 2>/dev/null | grep -P '^\+[^+]' | grep -vP '^\+\+\+ ' | grep -vP '^\+.*\.claude/hooks/pre-push-public-check\.sh' || true)
MESSAGES=$(git log "$BASE"..HEAD --format='%B' 2>/dev/null || true)
CONTENT=$(printf '%s\n%s' "$ADDED" "$MESSAGES")

# allowed addresses: attribution, examples, upstream's author, GitHub's no-reply
ALLOWED_EMAIL='noreply@anthropic\.com|@example\.com|users\.noreply\.github\.com|noreply@github\.com|hughhowey@gmail\.com'

HITS=''
report() { HITS="$HITS
[$1]
$(printf '%s' "$2" | head -5 | cut -c1-160)"; }

SECRETS=$(printf '%s' "$CONTENT" | grep -nP 'AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|AIza[0-9A-Za-z_-]{30,}' || true)
[ -n "$SECRETS" ] && report 'secret or token' "$SECRETS"

EMAILS=$(printf '%s' "$CONTENT" | grep -noP '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | grep -vP "$ALLOWED_EMAIL" || true)
[ -n "$EMAILS" ] && report 'email address' "$EMAILS"

PRIVATE_REPOS=$(printf '%s' "$CONTENT" | grep -noP '(github\.com/)?emanrow/(?!neo_hosted\b)[A-Za-z0-9_.-]+' || true)
[ -n "$PRIVATE_REPOS" ] && report 'a repository of the owner other than this one' "$PRIVATE_REPOS"

HOMES=$(printf '%s' "$CONTENT" | grep -noP '/Users/[A-Za-z0-9_.-]+|/home/(?!user\b)[A-Za-z0-9_.-]+|C:\\\\Users\\\\[A-Za-z0-9_.-]+' || true)
[ -n "$HOMES" ] && report 'a home-directory path' "$HOMES"

PERSONAL=$(printf '%s' "$CONTENT" | grep -niP 'America/[A-Z][a-z_]+|\b(Eastern|Central|Mountain|Pacific) (time|standard|daylight)\b|the owner (lives|works|is based)' || true)
[ -n "$PERSONAL" ] && report 'a time zone or location detail' "$PERSONAL"

if [ -n "$HITS" ]; then
  echo "BLOCKED: this push would publish something that must not be public." >&2
  echo "emanrow/neo_hosted is a PUBLIC repository. Found:" >&2
  printf '%s\n' "$HITS" >&2
  echo "" >&2
  echo "Remove it (or, for a false positive, change the wording so the pattern" >&2
  echo "no longer matches and say why in the PR). Policy: docs/public-repo.md" >&2
  exit 2
fi
exit 0
