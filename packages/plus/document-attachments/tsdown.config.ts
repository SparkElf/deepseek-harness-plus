import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@sparkelf/dsh-plugin-document-attachments',
  ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/mineru.js'],
  { hostPhase: true },
)
