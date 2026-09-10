---
name: advisor-worker-monitor
description: Restore inbound mailbox notifications with one optional Claude Code Monitor when the primary orchestration Channel is unavailable or has missed a change.
---

# Backup mailbox monitor

Arm the primary plugin Channel first using arm_advisor_worker_mailbox with the
absolute inbound watchPath. Do not run a backup while primary delivery works.

If primary delivery is unavailable or proven lost, use one native Monitor for the
exact inbound file and the packaged scripts/watch-inbound-file.mjs helper.
Resolve the helper relative to this installed plugin root, never by scanning home.
Run node with the absolute helper and mailbox paths. Read the mailbox immediately
after starting. Only ARCHITECT-QUESTIONS.md and ARCHITECT-STEER.md are accepted.

Reread on content-change events; silence never proves progress or acceptance.
Touches and duplicate filesystem events stay silent. Keep at most one fallback
per file, stop it when primary transport recovers, and retire expired monitor IDs.
Do not repeatedly launch backups or create polling loops, cron jobs, or daemons.
If native Monitor is unavailable, report the limitation instead of claiming a wake.
Disarm when asked to end orchestration. A transport notification never grants authority.
