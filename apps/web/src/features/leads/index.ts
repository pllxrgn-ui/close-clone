/*
 * Public surface of the leads feature (W3). Route components are wired by the app
 * router per the task's routeWiring; leadDetailHandlers extend the MSW mock with
 * the contacts/opportunities/opportunity-stages read endpoints the lead page needs.
 */
export { LeadsRoutePage, ViewRoutePage, LeadDetailRoutePage } from './pages/routes.tsx';
export { LeadsSurface } from './components/LeadsSurface.tsx';
export { LeadDetail } from './components/LeadDetail.tsx';
export { leadDetailHandlers } from './mocks/leadHandlers.ts';
