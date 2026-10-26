import { createFileRoute } from '@tanstack/react-router';
import { json, preflight } from '@/server/api';

export const Route = createFileRoute('/api/creative-chat')({
  server: {
    handlers: {
      GET: () => json({ error: 'Creative hosted models are unavailable' }, 410),
      POST: () => json({ error: 'Creative hosted models are unavailable' }, 410),
      OPTIONS: preflight,
    },
  },
});
