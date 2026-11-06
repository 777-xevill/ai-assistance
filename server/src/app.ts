import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { config, rootDir } from './config.ts';
import { HttpError } from './lib/http.ts';
import { logger } from './lib/logger.ts';
import { adminRouter } from './routes/admin.ts';
import { analyticsRouter, reportsRouter } from './routes/analytics.ts';
import { authRouter } from './routes/auth.ts';
import { catalogRouter } from './routes/catalog.ts';
import { channelsRouter } from './routes/channels.ts';
import { contactsRouter, inboxRouter } from './routes/inbox.ts';
import { knowledgeRouter } from './routes/knowledge.ts';
import { loadUser, requireSuperadmin, requireUser, requireWorkspace } from './routes/middleware.ts';
import { playgroundRouter } from './routes/playground.ts';
import { bookingsRouter, ordersRouter } from './routes/sales.ts';
import { webhooksRouter } from './routes/webhooks.ts';
import { chatPage, widgetRouter } from './routes/widget.ts';
import { workspaceRouter } from './routes/workspace.ts';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Webhooks read the raw body (signature checks), so they come before the JSON parser.
  app.use('/webhooks', webhooksRouter);

  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.use('/api/widget', widgetRouter);

  app.use(loadUser);
  app.use('/api/auth', authRouter);
  app.use('/api/admin', requireSuperadmin, adminRouter);

  const w = Router({ mergeParams: true });
  w.use(requireUser, requireWorkspace);
  w.use('/catalog', catalogRouter);
  w.use('/knowledge', knowledgeRouter);
  w.use('/channels', channelsRouter);
  w.use('/conversations', inboxRouter);
  w.use('/contacts', contactsRouter);
  w.use('/orders', ordersRouter);
  w.use('/bookings', bookingsRouter);
  w.use('/analytics', analyticsRouter);
  w.use('/reports', reportsRouter);
  w.use('/playground', playgroundRouter);
  w.use('/', workspaceRouter);
  app.use('/api/w/:wid', w);

  app.use('/api', (_req, _res) => {
    throw new HttpError(404, 'Not found');
  });

  // Uploaded and downloaded media (unguessable file names).
  app.use(
    '/media',
    express.static(config.mediaDir, { maxAge: '30d', immutable: true, index: false, dotfiles: 'deny', fallthrough: false }),
  );

  // Embeddable chat widget.
  const widgetFile = path.join(rootDir, 'server', 'public', 'widget.js');
  app.get('/widget.js', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/javascript').sendFile(widgetFile);
  });

  // Hosted chat page: the link and QR code businesses share with customers.
  app.get('/chat/:key', chatPage);

  // The dashboard (built React app) in production.
  const webDist = path.join(rootDir, 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || !req.accepts('html')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDist, 'index.html'));
    });
  } else if (!config.isProd) {
    app.get('/', (_req, res) => {
      res.redirect(config.webUrl);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
      return;
    }
    if (err instanceof multer.MulterError) {
      res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message });
      return;
    }
    const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
    if (status === 404) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message || 'Bad request' });
      return;
    }
    logger.error(`Unhandled error on ${req.method} ${req.path}`, { err });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}
