import { useCoalesced, useStream } from '@lalithesh-star/tape-react';
import { client } from './client';
import { InstrumentsGrid } from './InstrumentsGrid';
import { TapePanel } from './TapePanel';

export default function App() {
  const instruments = useStream(client, 'instruments', { priority: 1 });
  useCoalesced(instruments, 'volume', 'accumulate');

  const tape = useStream(client, 'tape', { priority: 0 });
  useCoalesced(tape, 'trades', { policy: 'sequence', capacity: 512 });

  return (
    <main>
      <InstrumentsGrid stream={instruments} />
      <TapePanel stream={tape} />
    </main>
  );
}
