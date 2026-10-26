import { createFileRoute } from '@tanstack/react-router';
import { json, preflight } from '@/server/api';

export const Route = createFileRoute('/api/prompt-generator')({
  server: {
    handlers: {
      GET: () => json({ error: 'Prompt generation is unavailable' }, 410),
      POST: () => json({ error: 'Prompt generation is unavailable' }, 410),
      OPTIONS: preflight,
    },
  },
});
