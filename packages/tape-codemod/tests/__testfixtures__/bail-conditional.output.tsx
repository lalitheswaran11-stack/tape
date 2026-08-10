import { useCoalesced, useStream } from '@lalithesh-star/tape-react';
import { client } from './client';

export function Quotes({ heavy }: { heavy: boolean }) {
  const stream = useStream(client, 'quotes');
  useCoalesced(stream, 'last', 'latest');
  if (heavy) {
    // TODO(tape-codemod): manual migration needed — useCoalesced inside a conditional or loop
    useCoalesced(stream, 'trades', 'sequence');
  }
  return <output>{stream.channel}</output>;
}
