import { createFileRoute } from '@tanstack/react-router';
import { handleLocalCadRender } from '@/server/localCadRender';

export const Route = createFileRoute('/api/local-cad-render')({
  server: {
    handlers: {
      GET: ({ request }) => handleLocalCadRender(request),
      POST: ({ request }) => handleLocalCadRender(request),
      OPTIONS: ({ request }) => handleLocalCadRender(request),
    },
  },
});
