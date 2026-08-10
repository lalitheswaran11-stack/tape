import { useRecordIds, useSubscription } from '@lalithesh-star/tape-react';
import { client } from './client';

export function Quotes() {
  const stream = useSubscription(client, {
    channel: 'quotes',

    policy: {
      last: 'latest',
      volume: 'accumulate',
      trades: { policy: 'sequence', capacity: 64 }
    }
  });
  const ids = useRecordIds(stream);
  return <div>{ids.length}</div>;
}
