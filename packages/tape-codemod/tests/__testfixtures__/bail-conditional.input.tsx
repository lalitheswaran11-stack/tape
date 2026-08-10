import { useCoalesced, useStream } from '@lalitheswaran11-stack/tape-react';
import { client } from './client';

export function Quotes({ heavy }: { heavy: boolean }) {
  const stream = useStream(client, 'quotes');
  useCoalesced(stream, 'last', 'latest');
  if (heavy) {
    useCoalesced(stream, 'trades', 'sequence');
  }
  return <output>{stream.channel}</output>;
}
