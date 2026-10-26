import { createFileRoute, redirect } from '@tanstack/react-router';
import { SignUpEmailView } from '@/views/SignUpEmailView';

export const Route = createFileRoute('/signup-email')({
  // Open instance: a guest session is created automatically, so these
  // routes just bounce to the app.
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true });
  },
  component: SignUpEmailView,
});
