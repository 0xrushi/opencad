import { createFileRoute, redirect } from '@tanstack/react-router';
import { SignInView } from '@/views/SignInView';

export const Route = createFileRoute('/signin')({
  // Open instance: a guest session is created automatically, so these
  // routes just bounce to the app.
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true });
  },
  component: SignInView,
});
