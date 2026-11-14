import { activity, fail, HttpError, id, json, now, type Env, type Context } from './core';
import { content } from './content';
import { abortExpired, media } from './media';
import { system, maintenance } from './system';
import { backup } from './backup';

async function fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  }
  const c = { req:request,url,env,db:env.DB,ctx };
  try {
    const readOnly = request.method === 'GET' || request.method === 'HEAD';
    if (!readOnly) {
      const origin = request.headers.get('origin');
      if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
        fail(403, 'Запрос отклонён. Откройте приложение на его собственном адресе.');
      }
    }
    const client = request.headers.get('CF-Connecting-IP') ?? 'local';
    const path = url.pathname;
    const group = path.startsWith('/api/uploads/') ? 'upload'
      : path.startsWith('/api/import') ? 'import'
      : path.startsWith('/api/export') ? 'export'
      : readOnly && (path.startsWith('/api/media/') || path.endsWith('/download')) ? 'media-read'
      : !readOnly || path === '/api/search' ? 'api' : undefined;
    if (env.RATE_LIMIT && group) {
      const limiter = group === 'media-read' || group === 'export' ? env.READ_RATE_LIMIT ?? env.RATE_LIMIT : env.RATE_LIMIT;
      const rate = await limiter.limit({ key: `${client}:${group}` });
      if (!rate.success) return json({error:'Слишком много запросов. Повторите через минуту.'},429,{'Retry-After':'60'});
    }
    const result = await backup(c) ?? await system(c) ?? await media(c) ?? await content(c);
    if (!result) fail(404,'Адрес API не найден.');
    result.headers.set('X-Content-Type-Options','nosniff');
    result.headers.set('Referrer-Policy','same-origin');
    result.headers.set('Cross-Origin-Resource-Policy','same-origin');
    return result;
  } catch (error) {
    if (error instanceof HttpError) return json({ error:error.message, code:error.code },error.status);
    const incident = id();
    console.error('studio API incident',incident,request.method,url.pathname,error);
    ctx.waitUntil(c.db.prepare('INSERT INTO storage_operations(id,action,status,detail,created_at) VALUES(?,?,?,?,?)')
      .bind(incident,'api','error',`Ошибка при обработке ${request.method} ${url.pathname.split('/').slice(0,3).join('/')}`,now())
      .run().catch(() => {}));
    return json({error:'Сервер не смог выполнить операцию. Проверьте соединение и состояние сервиса.',code:'SERVER_ERROR',incident},500);
  }
}
export default {
  fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const req = new Request('https://studio.local/api/system');
    const c: Context = { req,url:new URL(req.url),env,db:env.DB,ctx };
    try {
      await abortExpired(c);
      await maintenance(c);
    } catch (error) {
      console.error('studio maintenance',error);
      await activity(c,'Ошибка очистки хранилища','system').run();
    }
  }
};
