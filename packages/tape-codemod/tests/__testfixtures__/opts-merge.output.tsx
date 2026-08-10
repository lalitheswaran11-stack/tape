import { useRecordIds, useSubscription } from '@lalithesh-star/tape-react';
import { client } from './client';

export function Book({ channel }: { channel: string }) {
  // Non-literal channel is fine: any expression passes through.
  const stream = useSubscription(client, {
    channel,

    policy: {
      bids: 'latest',
      asks: 'latest'
    },

    priority: 2,
    snapshot: false
  });
  const ids = useRecordIds(stream);
  return <div>{ids.join(',')}</div>;
}
