import { useCoalesced, useStream } from '@lalithesh-star/tape-react';
import { client } from './client';
import { defaults } from './config';

export function Quotes() {
  const stream = useStream(client, 'quotes', { ...defaults, priority: 1 });
  useCoalesced(stream, 'last', 'latest');
  return <output>{stream.channel}</output>;
}
