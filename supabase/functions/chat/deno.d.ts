declare const Deno: {
  serve: (handler: (req: Request) => Promise<Response> | Response) => void;
  env: { get: (key: string) => string | undefined };
};

declare const Response: typeof globalThis.Response;
declare const Request: typeof globalThis.Request;
declare const fetch: typeof globalThis.fetch;
declare const console: Console;

declare module "supabase" {
  export function createClient(
    url: string,
    key: string,
    options?: Record<string, unknown>
  ): any;
}
