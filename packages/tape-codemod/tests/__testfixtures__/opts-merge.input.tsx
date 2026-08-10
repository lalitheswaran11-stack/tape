import { useCoalesced, useRecordIds, useStream } from '@lalitheswaran11-stack/tape-react';
import { client } from './client';

export function Book({ channel }: { channel: string }) {
  // Non-literal channel is fine: any expression passes through.
  const stream = useStream(client, channel, { priority: 2, snapshot: false });
  useCoalesced(stream, 'bids', 'latest');
  useCoalesced(stream, 'asks', 'latest');
  const ids = useRecordIds(stream);
  return <div>{ids.join(',')}</div>;
}
