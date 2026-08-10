import { useRecord, useStream } from '@lalitheswaran11-stack/tape-react';
import { client } from './client';

export function Price({ id }: { id: string }) {
  const stream = useStream(client, 'quotes');
  const rec = useRecord(stream, id);
  return <span>{String(rec?.fields['last'] ?? '-')}</span>;
}
