import { createFileRoute } from '@tanstack/react-router';
import { handleLocalCadRequest } from '@/server/localCad';

export const Route = createFileRoute('/api/local-cad')({
  server: {
    handlers: {
      GET: ({ request }) => handleLocalCadRequest(request),
      POST: ({ request }) => handleLocalCadRequest(request),
      OPTIONS: ({ request }) => handleLocalCadRequest(request),
    },
  },
});
