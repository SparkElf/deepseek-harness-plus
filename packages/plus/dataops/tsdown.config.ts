import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@sparkelf/dsh-plugin-dataops',
  ["lib/types/index.js","lib/types/invariant.js"],
  { hostPhase: true },
)
