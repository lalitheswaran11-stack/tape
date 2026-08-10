import {
  ConnectionBanner,
  PerfHud,
  useCoalesced,
  useRecord as useRec,
  useStream,
} from '@lalitheswaran11-stack/tape-react';
import type { Stream } from '@lalitheswaran11-stack/tape-react';
import { client } from './client';

function Last({ stream }: { stream: Stream }) {
  const rec = useRec(stream, 'AAPL');
  return <b>{String(rec?.fields['last'] ?? '-')}</b>;
}

export function Panel() {
  const stream = useStream(client, 'quotes');
  useCoalesced(stream, 'last', 'latest');
  return (
    <div>
      <ConnectionBanner client={client} />
      <Last stream={stream} />
      <PerfHud client={client} />
    </div>
  );
}
