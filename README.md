# tcr-agent

Auto-update payload for the telegram-claude-router agent. Deployed agents self-update
from this repo (see `updater.ts`): they poll `VERSION`, and when it's newer than the
running `version.ts` `AGENT_VERSION`, pull this repo's tarball and restart.

**To ship an update:** bump `VERSION` and `AGENT_VERSION` (keep them equal), push.
