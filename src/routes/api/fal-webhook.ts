import { createFileRoute } from '@tanstack/react-router';
import { json, preflight } from '@/server/api';

export const Route = createFileRoute('/api/fal-webhook')({
  server: {
    handlers: {
      POST: () => json({ error: 'Hosted mesh models are unavailable' }, 410),
      GET: () => json({ error: 'Hosted mesh models are unavailable' }, 410),
      OPTIONS: preflight,
    },
  },
});
