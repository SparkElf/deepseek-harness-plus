import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-mcp-dataops',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
