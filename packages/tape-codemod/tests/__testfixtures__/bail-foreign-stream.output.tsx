import { useCoalesced } from '@lalithesh-star/tape-react';
import type { Stream } from '@lalithesh-star/tape-react';

export function Child({ stream }: { stream: Stream }) {
  // TODO(tape-codemod): manual migration needed — stream is not a variable created by a useStream in the same function
  useCoalesced(stream, 'last', 'latest');
  return <output>{stream.channel}</output>;
}
