/* eslint-disable prettier/prettier */
import { CallHandler, ExecutionContext, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import {
  ApiResponseInterceptor,
  SKIP_RESPONSE_WRAP_KEY,
} from './api-response.interceptor';

/**
 * Helpers — on stubbe juste ce que l'interceptor lit :
 * - context.getType() === 'http'
 * - context.getHandler() / getClass()
 * - reflector.getAllAndOverride(...)
 */
function makeContext(opts: { type?: string } = {}): ExecutionContext {
  const type = opts.type ?? 'http';
  const handler = () => undefined;
  const classRef = class Dummy {};
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => classRef,
    switchToHttp: () =>
      ({
        getRequest: () => ({}),
        getResponse: () => ({}),
      }) as never,
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
    getArgs: () => [],
    getArgByIndex: () => undefined,
  } as unknown as ExecutionContext;
}

function makeHandler<T>(value: T): CallHandler {
  return { handle: () => of(value) };
}

function makeInterceptor(skipReturn = false) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(skipReturn),
  } as unknown as Reflector;
  return new ApiResponseInterceptor(reflector);
}

describe('ApiResponseInterceptor', () => {
  it('wraps a raw array in { data: [...] }', async () => {
    const interceptor = makeInterceptor();
    const res$ = interceptor.intercept(
      makeContext(),
      makeHandler([{ id: 1 }, { id: 2 }]),
    );
    await expect(firstValueFrom(res$)).resolves.toEqual({
      data: [{ id: 1 }, { id: 2 }],
    });
  });

  it('wraps a raw object in { data: {...} }', async () => {
    const interceptor = makeInterceptor();
    const res$ = interceptor.intercept(
      makeContext(),
      makeHandler({ id: 1, name: 'Lilia' }),
    );
    await expect(firstValueFrom(res$)).resolves.toEqual({
      data: { id: 1, name: 'Lilia' },
    });
  });

  it('passes through { data } untouched', async () => {
    const interceptor = makeInterceptor();
    const payload = { data: [{ id: 1 }] };
    const res$ = interceptor.intercept(makeContext(), makeHandler(payload));
    await expect(firstValueFrom(res$)).resolves.toEqual(payload);
  });

  it('passes through { data, message } untouched', async () => {
    const interceptor = makeInterceptor();
    const payload = { data: { id: 1 }, message: 'Créé' };
    const res$ = interceptor.intercept(makeContext(), makeHandler(payload));
    await expect(firstValueFrom(res$)).resolves.toEqual(payload);
  });

  it('passes through { data, message, meta } untouched', async () => {
    const interceptor = makeInterceptor();
    const payload = {
      data: [{ id: 1 }],
      message: 'OK',
      meta: { total: 1, page: 1 },
    };
    const res$ = interceptor.intercept(makeContext(), makeHandler(payload));
    await expect(firstValueFrom(res$)).resolves.toEqual(payload);
  });

  it('re-wraps { data, count } because `count` is not whitelisted', async () => {
    // Comportement attendu : on force la migration des endpoints qui exposaient
    // des clés ad-hoc à côté de `data`. Documenté dans la migration doc.
    const interceptor = makeInterceptor();
    const payload = { data: [1, 2], count: 2 };
    const res$ = interceptor.intercept(makeContext(), makeHandler(payload));
    await expect(firstValueFrom(res$)).resolves.toEqual({
      data: { data: [1, 2], count: 2 },
    });
  });

  it('wraps null as { data: null }', async () => {
    const interceptor = makeInterceptor();
    const res$ = interceptor.intercept(makeContext(), makeHandler(null));
    await expect(firstValueFrom(res$)).resolves.toEqual({ data: null });
  });

  it('wraps undefined as { data: null }', async () => {
    const interceptor = makeInterceptor();
    const res$ = interceptor.intercept(makeContext(), makeHandler(undefined));
    await expect(firstValueFrom(res$)).resolves.toEqual({ data: null });
  });

  it('wraps a primitive number in { data: 42 }', async () => {
    const interceptor = makeInterceptor();
    const res$ = interceptor.intercept(makeContext(), makeHandler(42));
    await expect(firstValueFrom(res$)).resolves.toEqual({ data: 42 });
  });

  it('wraps a primitive string in { data: "hello" }', async () => {
    const interceptor = makeInterceptor();
    const res$ = interceptor.intercept(makeContext(), makeHandler('hello'));
    await expect(firstValueFrom(res$)).resolves.toEqual({ data: 'hello' });
  });

  it('does not wrap StreamableFile responses', async () => {
    const interceptor = makeInterceptor();
    const stream = new StreamableFile(Buffer.from('pdf-bytes'));
    const res$ = interceptor.intercept(makeContext(), makeHandler(stream));
    await expect(firstValueFrom(res$)).resolves.toBe(stream);
  });

  it('does not wrap responses when @SkipResponseWrap() is set', async () => {
    const interceptor = makeInterceptor(true);
    const payload = { status: 'received' };
    const res$ = interceptor.intercept(makeContext(), makeHandler(payload));
    await expect(firstValueFrom(res$)).resolves.toEqual(payload);
  });

  it('does not touch non-HTTP contexts (WebSocket / RPC)', async () => {
    const interceptor = makeInterceptor();
    const payload = [1, 2, 3];
    const res$ = interceptor.intercept(
      makeContext({ type: 'ws' }),
      makeHandler(payload),
    );
    await expect(firstValueFrom(res$)).resolves.toBe(payload);
  });

  it('reads metadata using both handler and class scope (decorator override)', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const interceptor = new ApiResponseInterceptor(reflector);
    const ctx = makeContext();
    await firstValueFrom(
      interceptor.intercept(ctx, makeHandler({ status: 'ok' })),
    );
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      SKIP_RESPONSE_WRAP_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
  });
});
