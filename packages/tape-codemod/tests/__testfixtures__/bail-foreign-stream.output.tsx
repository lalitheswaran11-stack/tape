import { useCoalesced } from '@lalitheswaran11-stack/tape-react';
import type { Stream } from '@lalitheswaran11-stack/tape-react';

export function Child({ stream }: { stream: Stream }) {
  // TODO(tape-codemod): manual migration needed — stream is not a variable created by a useStream in the same function
  useCoalesced(stream, 'last', 'latest');
  return <output>{stream.channel}</output>;
}
