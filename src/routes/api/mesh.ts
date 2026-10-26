import { createFileRoute } from '@tanstack/react-router';
import { json, preflight } from '@/server/api';

export const Route = createFileRoute('/api/mesh')({
  server: {
    handlers: {
      GET: () => json({ error: 'Hosted mesh models are unavailable' }, 410),
      POST: () => json({ error: 'Hosted mesh models are unavailable' }, 410),
      OPTIONS: preflight,
    },
  },
});
