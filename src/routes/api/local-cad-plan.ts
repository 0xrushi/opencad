import { createFileRoute } from '@tanstack/react-router';
import { handleLocalCadPlan } from '@/server/localCadPlan';

export const Route = createFileRoute('/api/local-cad-plan')({
  server: {
    handlers: {
      POST: ({ request }) => handleLocalCadPlan(request),
      OPTIONS: ({ request }) => handleLocalCadPlan(request),
    },
  },
});
