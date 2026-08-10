import { useCoalesced, useStream } from '@lalithesh-star/tape-react';
import { client } from './client';
import { pickPolicy } from './policies';

export function Quotes({ mode }: { mode: string }) {
  const stream = useStream(client, 'quotes');
  useCoalesced(stream, 'last', pickPolicy(mode));
  return <output>{stream.channel}</output>;
}
