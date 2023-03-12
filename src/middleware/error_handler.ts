import Koa, { Context, Next } from 'koa';

export function errorHandler(): Koa.Middleware {
  return async function (ctx: Context, next: Next) {
    try {
      await next();
    } catch (err: any) {
      ctx.status = err.statusCode || err.status || 500;
      ctx.body = err.message;
      ctx.app.emit('error', err, ctx);
    }
  };
}
