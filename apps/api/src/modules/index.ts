import type { FastifyPluginAsync } from 'fastify';
import auth from './auth/routes';
import notifications from './notifications/routes';
import search from './search/routes';
// Front desk
import patients from './patients/routes';
import orders from './orders/routes';
import billing from './billing/routes';
// Samples, bench work, results and reports
import samples from './samples/routes';
import worklists from './worklists/routes';
import results from './results/routes';
import reports from './reports/routes';
import publicRoutes from './public/routes';
// Analyzers
import instruments from './instruments/routes';
import agents from './agents/routes';
import agentApi from './agent-api/routes';
import integration from './integration/routes';
import qc from './qc/routes';
// Lab administration and back office
import catalog from './catalog/routes';
import pricing from './pricing/routes';
import doctors from './doctors/routes';
import staff from './staff/routes';
import settings from './settings/routes';
import finance from './finance/routes';
import analytics from './analytics/routes';
import auditRoutes from './audit/routes';
import outbox from './outbox/routes';

/** Every API module and its URL prefix under /api/v1. */
export const modules: Array<{ prefix: string; plugin: FastifyPluginAsync }> = [
  { prefix: '/auth', plugin: auth },
  { prefix: '/notifications', plugin: notifications },
  { prefix: '/search', plugin: search },
  { prefix: '/patients', plugin: patients },
  { prefix: '/orders', plugin: orders },
  { prefix: '/billing', plugin: billing },
  { prefix: '/samples', plugin: samples },
  { prefix: '/worklists', plugin: worklists },
  { prefix: '/results', plugin: results },
  { prefix: '/reports', plugin: reports },
  { prefix: '/public', plugin: publicRoutes },
  { prefix: '/instruments', plugin: instruments },
  { prefix: '/agents', plugin: agents },
  { prefix: '/agent', plugin: agentApi },
  { prefix: '/integration', plugin: integration },
  { prefix: '/qc', plugin: qc },
  { prefix: '/catalog', plugin: catalog },
  { prefix: '/pricing', plugin: pricing },
  { prefix: '/doctors', plugin: doctors },
  { prefix: '/staff', plugin: staff },
  { prefix: '/settings', plugin: settings },
  { prefix: '/finance', plugin: finance },
  { prefix: '/analytics', plugin: analytics },
  { prefix: '/audit', plugin: auditRoutes },
  { prefix: '/outbox', plugin: outbox },
];
