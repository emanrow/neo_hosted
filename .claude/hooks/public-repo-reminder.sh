#!/bin/bash
# SessionStart and UserPromptSubmit: put the public-repository fact in front of
# the agent every time it is asked to do something. Usage: public-repo-reminder.sh <event>
EVENT="${1:-UserPromptSubmit}"
if [ "$EVENT" = "SessionStart" ]; then
  MSG='PUBLIC REPOSITORY. emanrow/neo_hosted is public on GitHub (it is a fork of hughhowey/neo). Everything you commit, push, write in a PR, issue or comment, or paste into a doc is visible to anyone. Before each write ask: would the owner mind a stranger reading this? Never include secrets or keys, personal details about the owner (schedule, time zone, location, employer, email), the names or contents of the owner'"'"'s private repositories, client or business information, or anything copied from a private source. Session attribution links in commits are fine. Policy and the audit log: docs/public-repo.md. A pre-push hook scans for the obvious cases; it is a net, not a substitute for judgment.'
else
  MSG='Reminder: this repository is PUBLIC. Nothing you write here (code, docs, commits, PR text, comments) may contain secrets, personal details about the owner, private repository names or contents, or client/business information. See docs/public-repo.md.'
fi
ESCAPED=$(printf '%s' "$MSG" | sed 's/"/\\"/g')
printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' "$EVENT" "$ESCAPED"
exit 0
