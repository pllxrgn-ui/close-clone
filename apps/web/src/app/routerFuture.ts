/**
 * Opt into React Router v7 behaviors now so the v6→v7 upgrade is a no-op and the
 * dev/test consoles stay free of future-flag warnings. Shared by the app's
 * BrowserRouter and the tests' MemoryRouter.
 */
export const ROUTER_FUTURE = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
} as const;
