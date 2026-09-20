import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@sparkelf/dsh-client-ui-skill-center',
  ['lib/types/index.js'],
  { hostPhase: true },
)
