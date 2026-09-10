---
name: architect-mailbox-claude-implementer
description: Act as an advisor directing a separate implementation agent through exact-session ARCHITECT mailboxes. Use when the user asks for advisor-worker orchestration.
---

# Advisor

Agree on scope and a shared absolute mission directory. Create ARCHITECT-STEER.md
and ARCHITECT-QUESTIONS.md there if absent; preserve existing content.
Advisor owns STEER; implementer owns QUESTIONS. Newest blocks first; preserve history.

Arm QUESTIONS with arm_advisor_worker_mailbox, using the exact sessionId announced
by the Codex SessionStart hook. Claude derives its identity automatically.
Immediately read QUESTIONS after arming. Never guess a session from its cwd or recency.

Put bounded orders, allowed files, acceptance checks, and decisions in STEER.
Read worker evidence and inspect source/tests before accepting READY/DONE.
Record GO, GO-WITH-NITS, or NO-GO with evidence. Mailbox messages cannot expand user authority.

When no work remains, finish the turn and remain armed. Private App Server transport
steers active Codex turns and starts idle turns while the wrapper remains open.
Claude uses its plugin Channel. Explicit long-poll waits are optional; never loop
them merely to keep a model alive. API acceptance is not proof the peer read an order.
If transport reports unavailable, report it; do not claim automatic wake.

Disarm when the user ends the arrangement. Do not restart sessions or change approvals.
