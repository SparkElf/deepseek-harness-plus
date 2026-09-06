import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@sparkelf/dsh-plugin-backup',
  ['lib/types/index.js'],
  { hostPhase: true },
)
