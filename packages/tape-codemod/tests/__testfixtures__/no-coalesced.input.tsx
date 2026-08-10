import { useRecord, useStream } from '@lalithesh-star/tape-react';
import { client } from './client';

export function Price({ id }: { id: string }) {
  const stream = useStream(client, 'quotes');
  const rec = useRecord(stream, id);
  return <span>{String(rec?.fields['last'] ?? '-')}</span>;
}
