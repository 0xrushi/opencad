import { createFileRoute } from '@tanstack/react-router';
import { json, preflight } from '@/server/api';

export const Route = createFileRoute('/api/title-generator')({
  server: {
    handlers: {
      GET: () => json({ error: 'Hosted title generation is unavailable' }, 410),
      POST: () => json({ error: 'Hosted title generation is unavailable' }, 410),
      OPTIONS: preflight,
    },
  },
});
