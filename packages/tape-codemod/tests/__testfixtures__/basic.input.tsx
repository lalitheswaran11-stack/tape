import { useCoalesced, useRecordIds, useStream } from '@lalitheswaran11-stack/tape-react';
import { client } from './client';

export function Quotes() {
  const stream = useStream(client, 'quotes');
  useCoalesced(stream, 'last', 'latest');
  useCoalesced(stream, 'volume', 'accumulate');
  useCoalesced(stream, 'trades', { policy: 'sequence', capacity: 64 });
  const ids = useRecordIds(stream);
  return <div>{ids.length}</div>;
}
