import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@sparkelf/dsh-plugin-backup',
  ['lib/types/index.js', 'lib/types/invariant.js'],
  { hostPhase: true },
)
