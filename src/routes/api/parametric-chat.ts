import { createFileRoute } from '@tanstack/react-router';
import { json, preflight } from '@/server/api';

export const Route = createFileRoute('/api/parametric-chat')({
  server: {
    handlers: {
      GET: () => json({ error: 'Use /api/local-cad' }, 410),
      POST: () => json({ error: 'Use /api/local-cad' }, 410),
      OPTIONS: preflight,
    },
  },
});
