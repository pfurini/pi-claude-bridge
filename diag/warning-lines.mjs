// Shared parsing for the bridge debug log's own lines, used by both
// audit-warnings.mjs (inventory) and gate-warnings.mjs (the integration gate) so
// the two cannot silently drift.
//
// Anchoring on the bridge's own `[iso] [module-id] ` prefix is load-bearing, not
// cosmetic: tool output is echoed into this log verbatim, so a bare /WARNING:/
// grep matches compiler output, other tools' logs, and any file the agent read.

// Capture groups: [1] date, [2] time, [3] module id, [4] message.
export const LINE = /^\[(\d{4}-\d{2}-\d{2})T([\d:.]+)Z\] \[([a-z0-9]+)\] (.*)$/;
export const NOTABLE = /^(WARNING|BUG)\b/;
