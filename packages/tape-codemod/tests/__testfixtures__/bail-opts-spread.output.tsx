import { useCoalesced, useStream } from '@lalithesh-star/tape-react';
import { client } from './client';
import { defaults } from './config';

export function Quotes() {
  // TODO(tape-codemod): manual migration needed — options object contains a spread
  const stream = useStream(client, 'quotes', { ...defaults, priority: 1 });
  useCoalesced(stream, 'last', 'latest');
  return <output>{stream.channel}</output>;
}
