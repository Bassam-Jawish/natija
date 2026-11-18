import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { Direction } from 'radix-ui';
import { Toaster } from 'sonner';
import { ApiError } from '@/lib/api';
import { AuthProvider } from '@/lib/auth';
import { useLang } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

export function App() {
  const lang = useLang();
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  return (
    <QueryClientProvider client={queryClient}>
      <Direction.Provider dir={dir}>
        <TooltipProvider>
          <AuthProvider>
            <RouterProvider router={router} />
            <Toaster position={dir === 'rtl' ? 'bottom-left' : 'bottom-right'} dir={dir} richColors closeButton />
          </AuthProvider>
        </TooltipProvider>
      </Direction.Provider>
    </QueryClientProvider>
  );
}
