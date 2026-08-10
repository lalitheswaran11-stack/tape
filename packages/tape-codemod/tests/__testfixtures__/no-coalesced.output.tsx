import { useRecord, useSubscription } from '@lalitheswaran11-stack/tape-react';
import { client } from './client';

export function Price({ id }: { id: string }) {
  const stream = useSubscription(client, {
    channel: 'quotes'
  });
  const rec = useRecord(stream, id);
  return <span>{String(rec?.fields['last'] ?? '-')}</span>;
}
