import { useSubscription } from '@lalitheswaran11-stack/tape-react';
import { client } from './client';
import { InstrumentsGrid } from './InstrumentsGrid';
import { TapePanel } from './TapePanel';

export default function App() {
  const instruments = useSubscription(client, {
    channel: 'instruments',

    policy: {
      volume: 'accumulate'
    },

    priority: 1
  });

  const tape = useSubscription(client, {
    channel: 'tape',

    policy: {
      trades: { policy: 'sequence', capacity: 512 }
    },

    priority: 0
  });

  return (
    <main>
      <InstrumentsGrid stream={instruments} />
      <TapePanel stream={tape} />
    </main>
  );
}
