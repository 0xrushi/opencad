import { createFileRoute, redirect } from '@tanstack/react-router';
import { SignUpView } from '@/views/SignUpView';

export const Route = createFileRoute('/signup')({
  // Open instance: a guest session is created automatically, so these
  // routes just bounce to the app.
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true });
  },
  component: SignUpView,
});
