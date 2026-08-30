import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@sparkelf/dsh-plugin-subagent-settings',
  ["lib/types/index.js","lib/types/startup.js","lib/types/invariant.js"],
  { hostPhase: true },
)
