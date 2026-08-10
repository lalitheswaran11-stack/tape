import { useCoalesced } from '@lalithesh-star/tape-react';
import type { Stream } from '@lalithesh-star/tape-react';

export function Child({ stream }: { stream: Stream }) {
  useCoalesced(stream, 'last', 'latest');
  return <output>{stream.channel}</output>;
}
