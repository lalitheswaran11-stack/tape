import { useSubscription } from '@lalithesh-star/tape-react';
import { client } from './client';

export function Quotes() {
  const s = useSubscription(client, {
    channel: 'quotes',

    policy: {
      last: 'latest',
      trades: { policy: 'sequence', capacity: 32 }
    }
  });
  return <output>{s.channel}</output>;
}
