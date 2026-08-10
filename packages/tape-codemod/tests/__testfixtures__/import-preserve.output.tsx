import { ConnectionBanner, PerfHud, useRecord as useRec, useSubscription } from '@lalitheswaran11-stack/tape-react';
import type { Stream } from '@lalitheswaran11-stack/tape-react';
import { client } from './client';

function Last({ stream }: { stream: Stream }) {
  const rec = useRec(stream, 'AAPL');
  return <b>{String(rec?.fields['last'] ?? '-')}</b>;
}

export function Panel() {
  const stream = useSubscription(client, {
    channel: 'quotes',

    policy: {
      last: 'latest'
    }
  });
  return (
    <div>
      <ConnectionBanner client={client} />
      <Last stream={stream} />
      <PerfHud client={client} />
    </div>
  );
}
