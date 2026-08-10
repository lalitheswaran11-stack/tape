import { useCoalesced as coalesce, useStream as openStream } from '@lalithesh-star/tape-react';
import { client } from './client';

export function Quotes() {
  const s = openStream(client, 'quotes');
  coalesce(s, 'last', 'latest');
  coalesce(s, 'trades', { policy: 'sequence', capacity: 32 });
  return <output>{s.channel}</output>;
}
