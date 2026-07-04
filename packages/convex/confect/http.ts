import { buildOpenApiDocument } from "@maestro-template/workflow-tooling";
import { confectManifest } from "@maestro-template/template-core/generated/confectManifest";
import { httpActionGeneric, httpRouter } from "convex/server";
import { api } from "../convex/_generated/api";
import { executeHeadlessOperation, type JsonValue } from "./manifest/executor";

type ManifestFunction = (typeof confectManifest.functions)[number];

const hasSurface = (entry: ManifestFunction, surface: string): boolean =>
  (entry.surfaces as readonly string[]).includes(surface);

export type TemplateHttpRoute = {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly description: string;
};

export type HeadlessHttpCtx = {
  readonly runQuery: (
    ref: unknown,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly runMutation: (
    ref: unknown,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly runAction: (
    ref: unknown,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
};

type TemplateApiRequestBody = {
  readonly workspaceSlug?: string;
  readonly input?: Record<string, JsonValue>;
  readonly idempotencyKey?: string;
};

const operationRefs = {
  "brain.pages.createMarkdown": api.brain.pages.createMarkdown,
} satisfies Record<string, unknown>;

export const securityHeaders = {
  "content-security-policy":
    "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

export const templateHttpRoutes = [
  {
    path: "/api/openapi.json",
    method: "GET",
    description: "Serves the generated OpenAPI 3.1 document.",
  },
  {
    path: "/api/docs",
    method: "GET",
    description: "Serves the Scalar API documentation shell.",
  },
  ...confectManifest.functions
    .filter((entry) => hasSurface(entry, "api"))
    .map((entry) => ({
      path: `/api/${entry.operationId}`,
      method: "POST" as const,
      description: `Executes ${entry.operationId}.`,
    })),
] as const satisfies readonly TemplateHttpRoute[];

const withSecurityHeaders = (
  headers: HeadersInit = {},
): Record<string, string> => {
  const merged: Record<string, string> = { ...securityHeaders };
  new Headers(headers).forEach((value, key) => {
    merged[key] = value;
  });
  return merged;
};

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value, null, 2), {
    headers: {
      ...securityHeaders,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const scalarDocsHtml = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Maestro Template API Docs</title>
    <script id="api-reference" data-url="/api/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </head>
  <body>
    <noscript>OpenAPI JSON is available at /api/openapi.json.</noscript>
  </body>
</html>
`;

const htmlResponse = (html: string): Response =>
  new Response(html, {
    headers: withSecurityHeaders({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    }),
  });

const readJsonBody = async (
  request: Request,
): Promise<TemplateApiRequestBody> => {
  if (!request.body) {
    return {};
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    return {};
  }

  const value = (await request.json()) as unknown;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as TemplateApiRequestBody;
};

const executorRequestFor = (
  operationId: string,
  body: TemplateApiRequestBody,
) => ({
  operationId,
  surface: "api" as const,
  input: body.input ?? {},
  ...(body.idempotencyKey === undefined
    ? {}
    : { idempotencyKey: body.idempotencyKey }),
});

export const handleTemplateHttpRequest = async (
  ctx: HeadlessHttpCtx,
  request: Request,
): Promise<Response> => {
  const url = new URL(request.url);

  if (url.pathname === "/api/openapi.json") {
    if (request.method !== "GET") {
      return jsonResponse({
        ok: false,
        error: {
          _tag: "MethodNotAllowed",
          message: "Only GET is supported for OpenAPI docs.",
        },
      });
    }

    return jsonResponse(buildOpenApiDocument());
  }

  if (url.pathname === "/api/docs") {
    if (request.method !== "GET") {
      return jsonResponse({
        ok: false,
        error: {
          _tag: "MethodNotAllowed",
          message: "Only GET is supported for Scalar docs.",
        },
      });
    }

    return htmlResponse(scalarDocsHtml());
  }

  const apiEntry = confectManifest.functions.find(
    (entry) =>
      hasSurface(entry, "api") && `/api/${entry.operationId}` === url.pathname,
  );

  if (apiEntry) {
    if (request.method !== "POST") {
      return jsonResponse({
        ok: false,
        error: {
          _tag: "MethodNotAllowed",
          message: `Only POST is supported for /api/${apiEntry.operationId}.`,
        },
      });
    }

    const body = await readJsonBody(request);

    return jsonResponse(
      await executeHeadlessOperation(
        {
          refs: operationRefs,
          runQuery: (ref, input) => ctx.runQuery(ref, input),
          runMutation: (ref, input) => ctx.runMutation(ref, input),
          runAction: (ref, input) => ctx.runAction(ref, input),
        },
        {
          ...executorRequestFor(apiEntry.operationId, body),
        },
      ),
    );
  }

  return jsonResponse({
    ok: false,
    error: {
      _tag: "NotFound",
      message: `Unknown template HTTP route: ${url.pathname}`,
    },
  });
};

/**
 * The deployable router. Convex requires convex/http's default export to be
 * an httpRouter, so every declared route is mounted onto one here; dispatch
 * (including the fail-closed 404) stays in handleTemplateHttpRequest above.
 */
const buildTemplateHttpRouter = () => {
  const router = httpRouter();
  const handler = httpActionGeneric(async (ctx, request) => {
    const headlessCtx: HeadlessHttpCtx = {
      runQuery: (ref, input) => ctx.runQuery(ref as never, input as never),
      runMutation: (ref, input) =>
        ctx.runMutation(ref as never, input as never),
      runAction: (ref, input) => ctx.runAction(ref as never, input as never),
    };

    return handleTemplateHttpRequest(headlessCtx, request);
  });
  for (const route of templateHttpRoutes) {
    router.route({ path: route.path, method: route.method, handler });
  }
  return router;
};

export default buildTemplateHttpRouter();
