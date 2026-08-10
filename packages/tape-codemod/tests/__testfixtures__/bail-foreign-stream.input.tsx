import { useCoalesced } from '@lalitheswaran11-stack/tape-react';
import type { Stream } from '@lalitheswaran11-stack/tape-react';

export function Child({ stream }: { stream: Stream }) {
  useCoalesced(stream, 'last', 'latest');
  return <output>{stream.channel}</output>;
}
